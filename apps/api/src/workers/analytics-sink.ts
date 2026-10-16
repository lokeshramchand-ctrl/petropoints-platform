import { randomUUID } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { TOPICS } from '@petropoints/contracts';
import {
  BronzeWriter,
  ClickHouseClient,
  MicroBatcher,
  parseEvent,
  toSilver,
  type SilverRow,
} from '../analytics/sink';
import { createKafka, runConsumer } from '../messaging/kafka';

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`${k} is required`);
  return v;
};

/**
 * Kafka -> (bronze: raw JSONL in S3) + (silver: typed rows in ClickHouse).
 * Bronze is written first: even if the warehouse transform is wrong, raw history is safe and replayable.
 */
async function main() {
  const brokers = env('KAFKA_BROKERS').split(',');
  const topics = [
    TOPICS['points.earned.v1'],
    TOPICS['points.redeemed.v1'],
    TOPICS['points.reversed.v1'],
  ];

  const ch = new ClickHouseClient({
    url: env('CLICKHOUSE_URL', 'http://localhost:8123'),
    user: env('CLICKHOUSE_USER', 'petropoints'),
    password: env('CLICKHOUSE_PASSWORD'),
  });
  const bronze = new BronzeWriter(
    new S3Client({
      endpoint: env('S3_ENDPOINT', 'http://localhost:9100'),
      region: env('S3_REGION', 'us-east-1'),
      forcePathStyle: true,
      credentials: { accessKeyId: env('S3_ACCESS_KEY'), secretAccessKey: env('S3_SECRET_KEY') },
    }),
    env('S3_BUCKET', 'petropoints-lake'),
  );

  const rawBatcher = new MicroBatcher<{ topic: string; payload: unknown }>(
    async (items) => {
      const byTopic = new Map<string, unknown[]>();
      for (const i of items) byTopic.set(i.topic, [...(byTopic.get(i.topic) ?? []), i.payload]);
      for (const [topic, payloads] of byTopic) await bronze.write(topic, payloads, randomUUID());
    },
    { maxItems: 500, maxWaitMs: 5_000 },
  );
  const silverBatcher = new MicroBatcher<SilverRow>(
    (rows) => ch.insertJsonEachRow('points_events', rows),
    {
      maxItems: 500,
      maxWaitMs: 2_000,
    },
  );

  const consumer = await runConsumer(createKafka(brokers, 'petropoints-analytics'), {
    groupId: 'petropoints-analytics',
    topics,
    handle: async (payload, topic) => {
      await rawBatcher.add({ topic, payload });
      const event = parseEvent(payload);
      const row = event && toSilver(event);
      if (row) await silverBatcher.add(row);
    },
  });
  console.log('analytics sink started');
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(
      sig,
      () =>
        void Promise.all([rawBatcher.flush(), silverBatcher.flush()])
          .then(() => consumer.disconnect())
          .then(() => process.exit(0)),
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
