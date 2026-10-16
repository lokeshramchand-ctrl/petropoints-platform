import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthService, MAX_FAILED_LOGINS } from '../src/auth/auth.service';
import { hashPassword, verifyPassword } from '../src/auth/password';
import { migrate } from '../src/db/migrate';
import { PgliteDb } from './helpers/pglite-db';

let db: PgliteDb;
let auth: AuthService;

const reg = {
  name: 'Ravi Kumar',
  email: 'ravi@example.com',
  mobile: '+919876543210',
  password: 'correct horse battery',
};

beforeAll(async () => {
  db = await PgliteDb.create();
  await migrate(db);
  auth = new AuthService(db, {
    accessSecret: 'test-access-secret-test-access-secret-xx',
    accessTtlSeconds: 900,
    refreshTtlSeconds: 3600,
  });
});
afterAll(() => db.close());
beforeEach(async () => {
  await db.exec(
    `TRUNCATE refresh_tokens, outbox_events, accounts, customers, users CASCADE;
     INSERT INTO accounts (kind) VALUES ('PROGRAM_ISSUANCE'),('PROGRAM_REDEMPTION'),('PROGRAM_ADJUSTMENT'),('PROGRAM_EXPIRY');`,
  );
});

describe('password hashing', () => {
  it('verifies the right password and rejects the wrong one', async () => {
    const h = await hashPassword('s3cret-password');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('s3cret-password', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
  });
  it('salts: same password hashes differently', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });
  it('rejects malformed stored hashes', async () => {
    expect(await verifyPassword('x', 'plaintext')).toBe(false);
  });
});

describe('customer registration', () => {
  it('creates user, customer, empty wallet and a welcome event atomically', async () => {
    const { customerId } = await auth.registerCustomer(reg);
    const wallet = await db.query<{ balance: string }>(
      `SELECT balance FROM accounts WHERE customer_id = $1`,
      [customerId],
    );
    expect(Number(wallet.rows[0]!.balance)).toBe(0);
    const ev = await db.query<{ topic: string }>('SELECT topic FROM outbox_events');
    expect(ev.rows).toEqual([{ topic: 'petropoints.user.registered.v1' }]);
  });

  it('never stores the plaintext password', async () => {
    await auth.registerCustomer(reg);
    const { rows } = await db.query<{ password_hash: string }>('SELECT password_hash FROM users');
    expect(rows[0]!.password_hash).not.toContain(reg.password);
  });

  it('rejects duplicate email and duplicate mobile with a conflict', async () => {
    await auth.registerCustomer(reg);
    await expect(auth.registerCustomer({ ...reg, mobile: '+919000000001' })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringMatching(/Email/),
    });
    await expect(
      auth.registerCustomer({ ...reg, email: 'other@example.com' }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringMatching(/Mobile/),
    });
  });
});

describe('login', () => {
  beforeEach(async () => {
    await auth.registerCustomer(reg);
  });

  it('issues an access token that resolves to the principal', async () => {
    const { tokens, principal } = await auth.login({ email: reg.email, password: reg.password });
    expect(principal.role).toBe('CUSTOMER');
    const verified = await auth.verifyAccessToken(tokens.accessToken);
    expect(verified).toMatchObject({ userId: principal.userId, role: 'CUSTOMER' });
  });

  it('gives the same error for unknown email and wrong password', async () => {
    const a = await auth
      .login({ email: 'nobody@example.com', password: 'whatever123' })
      .catch((e) => e);
    const b = await auth.login({ email: reg.email, password: 'wrong-password' }).catch((e) => e);
    expect(a).toMatchObject({ code: 'UNAUTHORIZED', message: 'Invalid credentials' });
    expect(b).toMatchObject({ code: 'UNAUTHORIZED', message: 'Invalid credentials' });
  });

  it(`locks the account after ${MAX_FAILED_LOGINS} failures, even for the right password`, async () => {
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) {
      await auth.login({ email: reg.email, password: 'wrong-password' }).catch(() => undefined);
    }
    await expect(auth.login({ email: reg.email, password: reg.password })).rejects.toMatchObject({
      code: 'ACCOUNT_LOCKED',
      status: 423,
    });
  });

  it('refuses disabled users', async () => {
    await db.query(`UPDATE users SET status = 'DISABLED'`);
    await expect(auth.login({ email: reg.email, password: reg.password })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});

describe('access tokens', () => {
  it('rejects garbage and tokens signed with another key', async () => {
    await expect(auth.verifyAccessToken('not.a.jwt')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    const other = new AuthService(db, {
      accessSecret: 'another-secret-another-secret-another-xx',
      accessTtlSeconds: 900,
      refreshTtlSeconds: 3600,
    });
    await auth.registerCustomer(reg);
    const { tokens } = await other.login({ email: reg.email, password: reg.password });
    await expect(auth.verifyAccessToken(tokens.accessToken)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});

describe('refresh token rotation', () => {
  beforeEach(async () => {
    await auth.registerCustomer(reg);
  });

  it('rotates: each refresh returns a new pair and spends the old token', async () => {
    const { tokens } = await auth.login({ email: reg.email, password: reg.password });
    const next = await auth.refresh(tokens.refreshToken);
    expect(next.refreshToken).not.toBe(tokens.refreshToken);
    await expect(auth.verifyAccessToken(next.accessToken)).resolves.toMatchObject({
      role: 'CUSTOMER',
    });
  });

  it('detects reuse of a spent token and revokes the entire family', async () => {
    const { tokens } = await auth.login({ email: reg.email, password: reg.password });
    const next = await auth.refresh(tokens.refreshToken);

    // attacker replays the stolen, already-spent token
    await expect(auth.refresh(tokens.refreshToken)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    // the legitimate holder's newest token is now dead too
    await expect(auth.refresh(next.refreshToken)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('logout revokes the session', async () => {
    const { tokens } = await auth.login({ email: reg.email, password: reg.password });
    await auth.logout(tokens.refreshToken);
    await expect(auth.refresh(tokens.refreshToken)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('rejects unknown tokens', async () => {
    await expect(auth.refresh('x'.repeat(43))).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
