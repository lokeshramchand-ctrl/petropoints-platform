import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate';
import { PgliteDb } from './helpers/pglite-db';

let db: PgliteDb;
beforeAll(async () => {
  db = await PgliteDb.create();
});
afterAll(() => db.close());

describe('migrations', () => {
  it('apply cleanly on an empty database', async () => {
    const ran = await migrate(db);
    expect(ran).toEqual([
      '001_tenancy.sql',
      '002_ledger.sql',
      '003_outbox_audit.sql',
      '004_processed_events.sql',
    ]);
  });

  it('are idempotent', async () => {
    expect(await migrate(db)).toEqual([]);
  });

  it('seed the four system accounts', async () => {
    const { rows } = await db.query<{ kind: string }>(
      `SELECT kind FROM accounts WHERE customer_id IS NULL ORDER BY kind`,
    );
    expect(rows.map((r) => r.kind)).toEqual([
      'PROGRAM_ADJUSTMENT',
      'PROGRAM_EXPIRY',
      'PROGRAM_ISSUANCE',
      'PROGRAM_REDEMPTION',
    ]);
  });
});
