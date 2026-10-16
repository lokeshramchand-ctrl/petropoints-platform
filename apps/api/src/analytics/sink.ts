import { gzipSync } from 'node:zlib';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { domainEvent, type DomainEvent } from '@petropoints/contracts';

/** Flat, typed row for the silver table (analytics.points_events). */
export interface SilverRow {
  event_id: string;
  event_type: string;
  occurred_at: string;
  transaction_id: string;
  customer_id: string;
  merchant_id: string | null;
  outlet_id: string | null;
  points: number;
  amount_paise: number | null;
  fuel_type: string | null;
  original_type: string | null;
}

/** ClickHouse DateTime64 wants "YYYY-MM-DD hh:mm:ss.mmm" in UTC, not ISO-8601 with a Z. */
const chTime = (iso: string) => iso.replace('T', ' ').replace('Z', '');

/** Bronze -> silver transform. Returns null for events with no analytical value (e.g. user.registered). */
export function toSilver(e: DomainEvent): SilverRow | null {
  switch (e.type) {
    case 'points.earned.v1':
      return {
        event_id: e.eventId,
        event_type: e.type,
        occurred_at: chTime(e.occurredAt),
        transaction_id: e.transactionId,
        customer_id: e.customerId,
        merchant_id: e.merchantId,
        outlet_id: e.outletId,
        points: e.points,
        amount_paise: e.amountPaise,
        fuel_type: e.fuelType,
        original_type: null,
      };
    case 'points.redeemed.v1':
      return {
        event_id: e.eventId,
        event_type: e.type,
        occurred_at: chTime(e.occurredAt),
        transaction_id: e.transactionId,
        customer_id: e.customerId,
        merchant_id: e.merchantId,
        outlet_id: e.outletId,
        points: -e.points,
        amount_paise: null,
        fuel_type: null,
        original_type: null,
      };
    case 'points.reversed.v1':
      return {
        event_id: e.eventId,
        event_type: e.type,
        occurred_at: chTime(e.occurredAt),
        transaction_id: e.transactionId,
        customer_id: e.customerId,
        merchant_id: e.merchantId ?? null,
        outlet_id: e.outletId ?? null,
        points: e.points,
        amount_paise: e.amountPaise ?? null,
        fuel_type: null,
        original_type: e.originalType ?? null,
      };
    default:
      return null;
  }
}

export interface ClickHouseConfig {
  url: string;
  user: string;
  password: string;
  database?: string;
}

export class ClickHouseClient {
  constructor(private readonly cfg: ClickHouseConfig) {}

  async insertJsonEachRow(table: string, rows: object[]): Promise<void> {
    if (rows.length === 0) return;
    const query = `INSERT INTO ${table} FORMAT JSONEachRow`;
    const res = await fetch(
      `${this.cfg.url}/?database=${this.cfg.database ?? 'analytics'}&query=${encodeURIComponent(query)}`,
      {
        method: 'POST',
        headers: {
          'X-ClickHouse-User': this.cfg.user,
          'X-ClickHouse-Key': this.cfg.password,
          // makes the whole batch atomic and idempotent enough with ReplacingMergeTree
          'X-ClickHouse-Format': 'JSONEachRow',
        },
        body: rows.map((r) => JSON.stringify(r)).join('\n'),
      },
    );
    if (!res.ok) throw new Error(`ClickHouse insert failed (${res.status}): ${await res.text()}`);
  }
}

/**
 * Bronze lake writer: immutable, gzip'd JSONL objects partitioned Hive-style by event date/hour,
 * so engines like Athena/Trino/Spark/DuckDB can prune partitions. Raw payloads are kept untouched
 * so silver can always be rebuilt (replay) when transformation logic changes.
 */
export class BronzeWriter {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  static objectKey(topic: string, at: Date, batchId: string): string {
    const iso = at.toISOString();
    return `bronze/topic=${topic}/dt=${iso.slice(0, 10)}/hour=${iso.slice(11, 13)}/${batchId}.jsonl.gz`;
  }

  async write(topic: string, payloads: unknown[], batchId: string): Promise<string> {
    const key = BronzeWriter.objectKey(topic, this.now(), batchId);
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: gzipSync(payloads.map((p) => JSON.stringify(p)).join('\n')),
        ContentType: 'application/x-ndjson',
        ContentEncoding: 'gzip',
      }),
    );
    return key;
  }
}

/** Buffers events and flushes by size or age: few large inserts, not one per event. */
export class MicroBatcher<T> {
  private buf: T[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly flushFn: (items: T[]) => Promise<void>,
    private readonly opts: { maxItems: number; maxWaitMs: number },
  ) {}

  async add(item: T): Promise<void> {
    this.buf.push(item);
    if (this.buf.length >= this.opts.maxItems) return this.flush();
    this.timer ??= setTimeout(() => void this.flush().catch(console.error), this.opts.maxWaitMs);
  }

  async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.buf.length === 0) return;
    const items = this.buf;
    this.buf = [];
    try {
      await this.flushFn(items);
    } catch (err) {
      this.buf = [...items, ...this.buf]; // keep for retry; nothing is dropped
      throw err;
    }
  }
}

/** Parses + validates; returns undefined for payloads from unknown/newer schema versions. */
export function parseEvent(payload: unknown): DomainEvent | undefined {
  const r = domainEvent.safeParse(payload);
  return r.success ? r.data : undefined;
}
