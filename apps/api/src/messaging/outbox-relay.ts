import type { Db } from '../db/db';

export interface OutboundMessage {
  topic: string;
  key: string;
  value: string;
  headers: Record<string, string>;
}

/** Transport port. Kafka in production, an in-memory fake in tests. */
export interface Publisher {
  publish(messages: OutboundMessage[]): Promise<void>;
}

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  topic: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export const MAX_ATTEMPTS = 10;

/**
 * Transactional outbox relay (at-least-once).
 *
 * Rows are claimed with FOR UPDATE SKIP LOCKED, so any number of relay replicas can run in parallel
 * without double-claiming. A crash between publish and commit re-delivers the batch; every event
 * carries a stable `eventId` and consumers de-duplicate on it.
 *
 * Rows that keep failing are parked after MAX_ATTEMPTS (dead-letter by predicate) so one poison
 * message can never block the queue behind it.
 */
export class OutboxRelay {
  constructor(
    private readonly db: Db,
    private readonly publisher: Publisher,
    private readonly opts: { batchSize?: number } = {},
  ) {}

  /** Publishes one batch. Returns how many events were sent. */
  async drainOnce(): Promise<number> {
    const limit = this.opts.batchSize ?? 100;
    try {
      return await this.db.tx(async (q) => {
        const rows = (
          await q.query<OutboxRow>(
            `SELECT id, aggregate_id, event_type, topic, payload, attempts
               FROM outbox_events
              WHERE published_at IS NULL AND attempts < $2
              ORDER BY created_at, id
              LIMIT $1
                FOR UPDATE SKIP LOCKED`,
            [limit, MAX_ATTEMPTS],
          )
        ).rows;
        if (rows.length === 0) return 0;

        await this.publisher.publish(
          rows.map((r) => ({
            topic: r.topic,
            // keyed by customer where present => per-customer ordering within a partition
            key: String((r.payload as { customerId?: string }).customerId ?? r.aggregate_id),
            value: JSON.stringify(r.payload),
            headers: {
              'event-type': r.event_type,
              'event-id': String((r.payload as { eventId?: string }).eventId),
            },
          })),
        );
        await q.query('UPDATE outbox_events SET published_at = now() WHERE id = ANY($1::uuid[])', [
          rows.map((r) => r.id),
        ]);
        return rows.length;
      });
    } catch (err) {
      // The claim transaction rolled back; record the failed attempt separately so poison rows age out.
      await this.db.query(
        `UPDATE outbox_events SET attempts = attempts + 1
          WHERE id IN (SELECT id FROM outbox_events WHERE published_at IS NULL AND attempts < $2
                       ORDER BY created_at, id LIMIT $1)`,
        [limit, MAX_ATTEMPTS],
      );
      throw err;
    }
  }

  /** Runs until `signal` aborts. Sleeps only when idle, so throughput is not capped by the poll interval. */
  async run(signal: AbortSignal, idleMs = 500, onError: (e: unknown) => void = console.error) {
    while (!signal.aborted) {
      try {
        const n = await this.drainOnce();
        if (n === 0) await sleep(idleMs, signal);
      } catch (e) {
        onError(e);
        await sleep(Math.min(idleMs * 4, 5000), signal);
      }
    }
  }

  async backlog(): Promise<number> {
    const r = await this.db.query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM outbox_events WHERE published_at IS NULL AND attempts < $1',
      [MAX_ATTEMPTS],
    );
    return Number(r.rows[0]!.n);
  }
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });
}
