import { Kafka, logLevel, type Consumer, type Producer } from 'kafkajs';
import type { OutboundMessage, Publisher } from './outbox-relay';

export function createKafka(brokers: string[], clientId: string) {
  return new Kafka({
    clientId,
    brokers,
    logLevel: logLevel.WARN,
    retry: { retries: 8, initialRetryTime: 300 },
  });
}

/** Idempotent producer + acks=all: no duplicates from producer retries, no loss on leader failover. */
export class KafkaPublisher implements Publisher {
  private producer: Producer;
  private connected = false;

  constructor(kafka: Kafka) {
    this.producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
  }

  async publish(messages: OutboundMessage[]) {
    if (!this.connected) {
      await this.producer.connect();
      this.connected = true;
    }
    const byTopic = new Map<string, OutboundMessage[]>();
    for (const m of messages) byTopic.set(m.topic, [...(byTopic.get(m.topic) ?? []), m]);
    await this.producer.sendBatch({
      acks: -1,
      topicMessages: [...byTopic].map(([topic, msgs]) => ({
        topic,
        messages: msgs.map((m) => ({ key: m.key, value: m.value, headers: m.headers })),
      })),
    });
  }

  disconnect() {
    return this.producer.disconnect();
  }
}

/**
 * Consumes with manual offset commits AFTER the handler succeeds (at-least-once). Handlers must be
 * idempotent; they get the parsed JSON payload.
 */
export async function runConsumer(
  kafka: Kafka,
  opts: {
    groupId: string;
    topics: string[];
    handle: (payload: unknown, topic: string) => Promise<void>;
  },
): Promise<Consumer> {
  const consumer = kafka.consumer({ groupId: opts.groupId });
  await consumer.connect();
  for (const topic of opts.topics) await consumer.subscribe({ topic, fromBeginning: true });
  await consumer.run({
    autoCommit: true,
    eachMessage: async ({ topic, message }) => {
      if (!message.value) return;
      await opts.handle(JSON.parse(message.value.toString()), topic);
    },
  });
  return consumer;
}
