import { loadConfig } from '../config/config';
import { PgDb } from '../db/pg-db';
import { createKafka, KafkaPublisher } from '../messaging/kafka';
import { OutboxRelay } from '../messaging/outbox-relay';

async function main() {
  const config = loadConfig();
  if (config.KAFKA_BROKERS.length === 0) throw new Error('KAFKA_BROKERS is required for the relay');
  const db = new PgDb({ connectionString: config.DATABASE_URL, max: 4 });
  const publisher = new KafkaPublisher(
    createKafka(config.KAFKA_BROKERS, 'petropoints-outbox-relay'),
  );
  const relay = new OutboxRelay(db, publisher);

  const stop = new AbortController();
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => stop.abort());

  console.log('outbox relay started');
  await relay.run(stop.signal);
  await publisher.disconnect();
  await db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
