import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate';
import { LedgerService } from '../src/ledger/ledger.service';
import { verifySlip } from '../src/ledger/slip';
import { PgliteDb } from './helpers/pglite-db';
import { seedWorld, type World } from './helpers/seed';

const SECRET = 'test-slip-secret-test-slip-secret-xx';
let db: PgliteDb;
let ledger: LedgerService;
let w: World;

const key = () => `k-${randomUUID()}`;
const earnReq = (over: Partial<{ amountPaise: number; outletId: string }> = {}) => ({
  customerMobile: w.customerMobile,
  outletId: over.outletId ?? w.outletA1,
  amountPaise: over.amountPaise ?? 250_000, // ₹2500 -> 25 pts
  fuelType: 'PETROL' as const,
});

async function balance(): Promise<number> {
  const { rows } = await db.query<{ balance: string }>(
    `SELECT balance FROM accounts WHERE customer_id = $1 AND kind = 'CUSTOMER_WALLET'`,
    [w.customerId],
  );
  return Number(rows[0]!.balance);
}

beforeAll(async () => {
  db = await PgliteDb.create();
  await migrate(db);
  ledger = new LedgerService(db, { slipHmacSecret: SECRET });
});
afterAll(() => db.close());
beforeEach(async () => {
  // fresh tenants + empty ledger for each test
  await db.exec(`
    ALTER TABLE ledger_entries DISABLE TRIGGER ALL;
    ALTER TABLE transactions DISABLE TRIGGER ALL;
    TRUNCATE ledger_entries, transactions, outbox_events, outlet_slip_counters, devices,
      accounts, customers, refresh_tokens, users, outlets, merchants RESTART IDENTITY CASCADE;
    ALTER TABLE ledger_entries ENABLE TRIGGER ALL;
    ALTER TABLE transactions ENABLE TRIGGER ALL;
    INSERT INTO accounts (kind) VALUES
      ('PROGRAM_ISSUANCE'),('PROGRAM_REDEMPTION'),('PROGRAM_ADJUSTMENT'),('PROGRAM_EXPIRY');`);
  w = await seedWorld(db);
});

describe('earn', () => {
  it('credits floor(amount/₹100) points and returns a signed slip', async () => {
    const r = await ledger.earn(w.cashierA1, key(), earnReq());
    expect(r.points).toBe(25);
    expect(r.balanceAfter).toBe(25);
    expect(await balance()).toBe(25);
    expect(r.slip?.slipNumber).toMatch(/^ALP1-\d{8}-000001$/);
    expect(r.slip?.customerMobileMasked).toBe('+91*******210');
    expect(
      verifySlip(SECRET, { ...r.slip!, transactionId: r.transactionId }, r.slip!.signature),
    ).toBe(true);
  });

  it('numbers slips sequentially per outlet', async () => {
    await ledger.earn(w.cashierA1, key(), earnReq());
    const second = await ledger.earn(w.cashierA1, key(), earnReq());
    const other = await ledger.earn(w.cashierA2, key(), earnReq({ outletId: w.outletA2 }));
    expect(second.slip?.slipNumber).toMatch(/-000002$/);
    expect(other.slip?.slipNumber).toMatch(/^ALP2-\d{8}-000001$/);
  });

  it('rejects spends too small to earn a point', async () => {
    await expect(
      ledger.earn(w.cashierA1, key(), earnReq({ amountPaise: 5_000 })),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('is idempotent: a retry returns the same transaction and does not double-award', async () => {
    const k = key();
    const a = await ledger.earn(w.cashierA1, k, earnReq());
    const b = await ledger.earn(w.cashierA1, k, earnReq());
    expect(b.replayed).toBe(true);
    expect(b.transactionId).toBe(a.transactionId);
    expect(b.slip?.slipNumber).toBe(a.slip?.slipNumber);
    expect(await balance()).toBe(25);
  });

  it('rejects reusing an idempotency key with a different body', async () => {
    const k = key();
    await ledger.earn(w.cashierA1, k, earnReq());
    await expect(
      ledger.earn(w.cashierA1, k, earnReq({ amountPaise: 999_999 })),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
  });

  it('emits exactly one outbox event per transaction, in the same commit', async () => {
    const k = key();
    await ledger.earn(w.cashierA1, k, earnReq());
    await ledger.earn(w.cashierA1, k, earnReq()); // replay: no new event
    const { rows } = await db.query<{ event_type: string; topic: string }>(
      'SELECT event_type, topic FROM outbox_events',
    );
    expect(rows).toEqual([
      { event_type: 'points.earned.v1', topic: 'petropoints.points.earned.v1' },
    ]);
  });
});

describe('tenant isolation (RBAC scope)', () => {
  it('a cashier cannot award at another outlet of the same merchant', async () => {
    await expect(
      ledger.earn(w.cashierA1, key(), earnReq({ outletId: w.outletA2 })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it("a merchant owner cannot award at another merchant's outlet", async () => {
    await expect(
      ledger.earn(w.ownerA, key(), earnReq({ outletId: w.outletB1 })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('customers cannot earn for themselves', async () => {
    await expect(ledger.earn(w.customerActor, key(), earnReq())).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('unknown customers and suspended outlets are refused', async () => {
    await expect(
      ledger.earn(w.cashierA1, key(), { ...earnReq(), customerMobile: '+919000000000' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await db.query(`UPDATE outlets SET status = 'SUSPENDED' WHERE id = $1`, [w.outletA1]);
    await expect(ledger.earn(w.cashierA1, key(), earnReq())).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
});

describe('redeem', () => {
  it('debits points and refuses overdraft', async () => {
    await ledger.earn(w.cashierA1, key(), earnReq());
    const r = await ledger.redeem(w.cashierA1, key(), {
      customerMobile: w.customerMobile,
      outletId: w.outletA1,
      points: 10,
    });
    expect(r.points).toBe(-10);
    expect(await balance()).toBe(15);

    await expect(
      ledger.redeem(w.cashierA1, key(), {
        customerMobile: w.customerMobile,
        outletId: w.outletA1,
        points: 16,
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_POINTS' });
    expect(await balance()).toBe(15);
  });
});

describe('reversal', () => {
  it('reverses an earn by posting opposite entries, never editing history', async () => {
    const earn = await ledger.earn(w.cashierA1, key(), earnReq());
    const rev = await ledger.reverse(w.ownerA, key(), earn.transactionId, 'wrong amount keyed');
    expect(rev.type).toBe('REVERSAL');
    expect(rev.points).toBe(-25);
    expect(await balance()).toBe(0);
    const { rows } = await db.query('SELECT 1 FROM transactions');
    expect(rows).toHaveLength(2);
  });

  it('cannot be reversed twice', async () => {
    const earn = await ledger.earn(w.cashierA1, key(), earnReq());
    await ledger.reverse(w.ownerA, key(), earn.transactionId, 'first');
    await expect(
      ledger.reverse(w.ownerA, key(), earn.transactionId, 'second'),
    ).rejects.toMatchObject({ code: 'ALREADY_REVERSED' });
    expect(await balance()).toBe(0);
  });

  it('refuses to reverse an earn whose points were already spent', async () => {
    const earn = await ledger.earn(w.cashierA1, key(), earnReq());
    await ledger.redeem(w.cashierA1, key(), {
      customerMobile: w.customerMobile,
      outletId: w.outletA1,
      points: 20,
    });
    await expect(ledger.reverse(w.ownerA, key(), earn.transactionId, 'oops')).rejects.toMatchObject(
      { code: 'INSUFFICIENT_POINTS' },
    );
  });

  it("a different merchant's owner cannot reverse it; support can", async () => {
    const earn = await ledger.earn(w.cashierA1, key(), earnReq());
    await expect(
      ledger.reverse(w.ownerB, key(), earn.transactionId, 'sneaky'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      ledger.reverse(w.support, key(), earn.transactionId, 'customer complaint'),
    ).resolves.toMatchObject({ type: 'REVERSAL' });
  });

  it('cashiers cannot reverse', async () => {
    const earn = await ledger.earn(w.cashierA1, key(), earnReq());
    await expect(
      ledger.reverse(w.cashierA1, key(), earn.transactionId, 'nope'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('adjustment', () => {
  it('only SUPER_ADMIN may adjust', async () => {
    await expect(
      ledger.adjust(w.support, key(), w.customerId, 5, 'goodwill'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const r = await ledger.adjust(w.superAdmin, key(), w.customerId, 5, 'goodwill');
    expect(r.balanceAfter).toBe(5);
  });
});

describe('database invariants (hold even if application code is bypassed)', () => {
  it('the ledger always sums to zero and wallets equal their entries', async () => {
    await ledger.earn(w.cashierA1, key(), earnReq());
    const e = await ledger.earn(w.cashierA1, key(), earnReq({ amountPaise: 100_000 }));
    await ledger.redeem(w.cashierA1, key(), {
      customerMobile: w.customerMobile,
      outletId: w.outletA1,
      points: 7,
    });
    await ledger.reverse(w.ownerA, key(), e.transactionId, 'test');

    const total = await db.query<{ s: string }>(
      'SELECT COALESCE(SUM(delta),0) AS s FROM ledger_entries',
    );
    expect(Number(total.rows[0]!.s)).toBe(0);

    const recon = await db.query<{ cached: string; derived: string }>(
      `SELECT a.balance AS cached, COALESCE(SUM(l.delta),0) AS derived
         FROM accounts a LEFT JOIN ledger_entries l ON l.account_id = a.id
        WHERE a.kind = 'CUSTOMER_WALLET' GROUP BY a.id`,
    );
    expect(Number(recon.rows[0]!.cached)).toBe(Number(recon.rows[0]!.derived));
  });

  it('rejects an unbalanced ledger transaction at commit', async () => {
    const earn = await ledger.earn(w.cashierA1, key(), earnReq());
    await expect(
      db.tx(async (q) => {
        await q.query(
          'INSERT INTO ledger_entries (transaction_id, account_id, delta) SELECT $1, id, 5 FROM accounts LIMIT 1',
          [earn.transactionId],
        );
      }),
    ).rejects.toThrow(/unbalanced/);
  });

  it('forbids updating or deleting ledger rows', async () => {
    await ledger.earn(w.cashierA1, key(), earnReq());
    await expect(db.query('UPDATE transactions SET points = 999')).rejects.toThrow(/append-only/);
    await expect(db.query('DELETE FROM ledger_entries')).rejects.toThrow(/append-only/);
  });

  it('forbids a negative wallet balance at the database level', async () => {
    await expect(
      db.query(`UPDATE accounts SET balance = -1 WHERE customer_id = $1`, [w.customerId]),
    ).rejects.toThrow(/accounts_wallet_nonneg_chk/);
  });
});
