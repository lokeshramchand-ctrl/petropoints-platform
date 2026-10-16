import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { domainEvent } from '@petropoints/contracts';
import { BronzeWriter, MicroBatcher, parseEvent, toSilver } from '../src/analytics/sink';
import { AuthService } from '../src/auth/auth.service';
import { migrate } from '../src/db/migrate';
import { LedgerService } from '../src/ledger/ledger.service';
import { MemoryMailer } from '../src/mail/mail.service';
import { NotificationHandler } from '../src/messaging/notifications';
import {
  MAX_ATTEMPTS,
  OutboxRelay,
  type OutboundMessage,
  type Publisher,
} from '../src/messaging/outbox-relay';
import { PgliteDb } from './helpers/pglite-db';
import { seedWorld, type World } from './helpers/seed';

class FakeBus implements Publisher {
  sent: OutboundMessage[] = [];
  failNext = false;
  async publish(m: OutboundMessage[]) {
    if (this.failNext) throw new Error('broker down');
    this.sent.push(...m);
  }
}

let db: PgliteDb;
let ledger: LedgerService;
let w: World;
const key = () => `k-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const earn = () =>
  ledger.earn(w.cashierA1, key(), {
    customerMobile: w.customerMobile,
    outletId: w.outletA1,
    amountPaise: 250_000,
    fuelType: 'PETROL',
  });

beforeAll(async () => {
  db = await PgliteDb.create();
  await migrate(db);
  ledger = new LedgerService(db, { slipHmacSecret: 'x'.repeat(40) });
});
afterAll(() => db.close());
beforeEach(async () => {
  await db.exec(`
    ALTER TABLE ledger_entries DISABLE TRIGGER ALL; ALTER TABLE transactions DISABLE TRIGGER ALL;
    TRUNCATE ledger_entries, transactions, outbox_events, processed_events, outlet_slip_counters, devices,
      accounts, customers, refresh_tokens, users, outlets, merchants RESTART IDENTITY CASCADE;
    ALTER TABLE ledger_entries ENABLE TRIGGER ALL; ALTER TABLE transactions ENABLE TRIGGER ALL;
    INSERT INTO accounts (kind) VALUES ('PROGRAM_ISSUANCE'),('PROGRAM_REDEMPTION'),('PROGRAM_ADJUSTMENT'),('PROGRAM_EXPIRY');`);
  w = await seedWorld(db);
});

describe('outbox relay', () => {
  it('publishes committed events to the right topic, keyed by customer, and marks them sent', async () => {
    await earn();
    const bus = new FakeBus();
    const relay = new OutboxRelay(db, bus);
    expect(await relay.backlog()).toBe(1);
    expect(await relay.drainOnce()).toBe(1);
    expect(bus.sent[0]).toMatchObject({ topic: 'petropoints.points.earned.v1', key: w.customerId });
    expect(bus.sent[0]!.headers['event-type']).toBe('points.earned.v1');
    expect(domainEvent.safeParse(JSON.parse(bus.sent[0]!.value)).success).toBe(true);
    expect(await relay.backlog()).toBe(0);
    expect(await relay.drainOnce()).toBe(0); // nothing is published twice
  });

  it('keeps events when the broker is down and delivers them on recovery', async () => {
    await earn();
    const bus = new FakeBus();
    const relay = new OutboxRelay(db, bus);
    bus.failNext = true;
    await expect(relay.drainOnce()).rejects.toThrow('broker down');
    expect(await relay.backlog()).toBe(1);
    bus.failNext = false;
    expect(await relay.drainOnce()).toBe(1);
    expect(bus.sent).toHaveLength(1);
  });

  it('parks poison events after MAX_ATTEMPTS so they cannot block the queue', async () => {
    await earn();
    const bus = new FakeBus();
    const relay = new OutboxRelay(db, bus);
    bus.failNext = true;
    for (let i = 0; i < MAX_ATTEMPTS; i++) await relay.drainOnce().catch(() => undefined);
    expect(await relay.backlog()).toBe(0);
    const parked = await db.query('SELECT 1 FROM outbox_events WHERE published_at IS NULL');
    expect(parked.rows).toHaveLength(1); // still stored for inspection / manual replay
  });

  it('emits reversal events that carry enough context for analytics', async () => {
    const e = await earn();
    await ledger.reverse(w.ownerA, key(), e.transactionId, 'test');
    const bus = new FakeBus();
    await new OutboxRelay(db, bus).drainOnce();
    const rev = JSON.parse(bus.sent.find((m) => m.topic.endsWith('reversed.v1'))!.value);
    expect(rev).toMatchObject({
      originalType: 'EARN',
      merchantId: w.merchantA,
      amountPaise: 250_000,
      points: -25,
    });
  });
});

describe('notifications consumer', () => {
  it('sends a welcome email for registrations, once, even if the event is redelivered', async () => {
    const auth = new AuthService(db, {
      accessSecret: 'a'.repeat(40),
      accessTtlSeconds: 900,
      refreshTtlSeconds: 3600,
    });
    await auth.registerCustomer({
      name: 'Asha',
      email: 'asha@example.com',
      mobile: '+919111111111',
      password: 'long-password-1',
    });
    const bus = new FakeBus();
    await new OutboxRelay(db, bus).drainOnce();

    const mail = new MemoryMailer();
    const handler = new NotificationHandler(db, mail);
    const payload = JSON.parse(bus.sent[0]!.value);
    expect(await handler.handle(payload)).toBe('sent');
    expect(await handler.handle(payload)).toBe('duplicate');
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({
      to: 'asha@example.com',
      subject: 'Welcome to PetroPoints',
    });
  });

  it('emails the customer when points are earned and escapes HTML in names', async () => {
    await db.query(`UPDATE customers SET name = '<script>x</script>' WHERE id = $1`, [
      w.customerId,
    ]);
    await earn();
    const bus = new FakeBus();
    await new OutboxRelay(db, bus).drainOnce();
    const mail = new MemoryMailer();
    await new NotificationHandler(db, mail).handle(JSON.parse(bus.sent[0]!.value));
    expect(mail.sent[0]!.subject).toBe('You earned 25 PetroPoints');
    expect(mail.sent[0]!.html).not.toContain('<script>');
  });

  it('ignores events from unknown schema versions instead of crashing', async () => {
    const handler = new NotificationHandler(db, new MemoryMailer());
    expect(await handler.handle({ type: 'points.earned.v9', whatever: true })).toBe('ignored');
  });
});

describe('analytics transforms', () => {
  it('maps events to typed silver rows with ClickHouse-style timestamps', async () => {
    const e = await earn();
    await ledger.redeem(w.cashierA1, key(), {
      customerMobile: w.customerMobile,
      outletId: w.outletA1,
      points: 5,
    });
    await ledger.reverse(w.ownerA, key(), e.transactionId, 'nope').catch(() => undefined); // spent -> refused
    const bus = new FakeBus();
    await new OutboxRelay(db, bus).drainOnce();

    const rows = bus.sent.map((m) => toSilver(parseEvent(JSON.parse(m.value))!)!);
    expect(rows[0]).toMatchObject({
      event_type: 'points.earned.v1',
      points: 25,
      amount_paise: 250_000,
      fuel_type: 'PETROL',
    });
    expect(rows[1]).toMatchObject({
      event_type: 'points.redeemed.v1',
      points: -5,
      amount_paise: null,
    });
    expect(rows[0]!.occurred_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
  });

  it('skips non-analytical events and unknown versions', () => {
    expect(parseEvent({ type: 'points.earned.v2' })).toBeUndefined();
  });

  it('partitions the bronze lake Hive-style by date and hour', () => {
    const key = BronzeWriter.objectKey(
      'petropoints.points.earned.v1',
      new Date('2026-10-16T09:30:00Z'),
      'abc',
    );
    expect(key).toBe(
      'bronze/topic=petropoints.points.earned.v1/dt=2026-10-16/hour=09/abc.jsonl.gz',
    );
  });

  it('bronze objects are gzipped JSONL', async () => {
    const puts: Array<{ Body: Buffer }> = [];
    const s3 = {
      send: async (cmd: { input: { Body: Buffer } }) => void puts.push(cmd.input),
    } as never;
    await new BronzeWriter(s3, 'lake', () => new Date('2026-10-16T09:00:00Z')).write(
      't',
      [{ a: 1 }, { a: 2 }],
      'id',
    );
    expect(gunzipSync(puts[0]!.Body).toString()).toBe('{"a":1}\n{"a":2}');
  });
});

describe('micro-batcher', () => {
  it('flushes at size, and retains items if the sink fails', async () => {
    const flushed: number[][] = [];
    let fail = true;
    const b = new MicroBatcher<number>(
      async (items) => {
        if (fail) throw new Error('sink down');
        flushed.push(items);
      },
      { maxItems: 2, maxWaitMs: 10_000 },
    );
    await b.add(1);
    await expect(b.add(2)).rejects.toThrow('sink down');
    fail = false;
    await b.add(3); // buffer is [1,2,3] again >= maxItems, so it flushes in order
    expect(flushed).toEqual([[1, 2, 3]]);
  });
});
