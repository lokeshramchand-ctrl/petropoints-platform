import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/auth/password';
import { createApp } from '../src/bootstrap';
import { loadConfig } from '../src/config/config';
import { migrate } from '../src/db/migrate';
import { PgliteDb } from './helpers/pglite-db';

let app: NestFastifyApplication;
let db: PgliteDb;

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://x:y@localhost:5432/z',
  JWT_ACCESS_SECRET: 'e2e-access-secret-e2e-access-secret-xxxx',
  JWT_REFRESH_SECRET: 'e2e-refresh-secret-e2e-refresh-secret-xx',
  SLIP_HMAC_SECRET: 'e2e-slip-secret-e2e-slip-secret-xxxxxxx',
  PII_HASH_PEPPER: 'e2e-pepper-e2e-pepper-e2e-pepper-xxxxx',
});

type Res = { statusCode: number; json: () => any; headers: Record<string, unknown> };
async function call(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Res> {
  return app.inject({
    method,
    url,
    payload: opts.body as object | undefined,
    headers: {
      ...(opts.token && { authorization: `Bearer ${opts.token}` }),
      ...opts.headers,
    },
  }) as unknown as Res;
}
const idem = () => ({ 'idempotency-key': `e2e-${randomUUID()}` });

async function login(email: string, password: string): Promise<string> {
  const r = await call('POST', '/v1/auth/login', { body: { email, password } });
  expect(r.statusCode).toBe(200);
  return r.json().accessToken;
}

const ADMIN_PW = 'admin-password-123';
let adminToken: string;
let merchantId: string;
let outletId: string;
let cashierToken: string;
let customerToken: string;

beforeAll(async () => {
  db = await PgliteDb.create();
  await migrate(db);
  await db.query(
    `INSERT INTO users (email, name, password_hash, role) VALUES ('admin@petropoints.test','Admin',$1,'SUPER_ADMIN')`,
    [await hashPassword(ADMIN_PW)],
  );
  app = await createApp(config, db);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  adminToken = await login('admin@petropoints.test', ADMIN_PW);
});
afterAll(async () => {
  await app.close();
  await db.close();
});

describe('onboarding (back office)', () => {
  it('admin creates merchant, outlet, cashier and POS device', async () => {
    const m = await call('POST', '/v1/merchants', {
      token: adminToken,
      body: { name: 'Alpha Fuels' },
    });
    expect(m.statusCode).toBe(201);
    merchantId = m.json().id;

    const o = await call('POST', `/v1/merchants/${merchantId}/outlets`, {
      token: adminToken,
      body: { code: 'alp1', name: 'Alpha Anna Nagar', city: 'Chennai' },
    });
    expect(o.statusCode).toBe(201);
    outletId = o.json().id;
    expect(o.json().code).toBe('ALP1');

    const s = await call('POST', `/v1/merchants/${merchantId}/staff`, {
      token: adminToken,
      body: {
        email: 'Cash@Alpha.test',
        name: 'Cashier One',
        role: 'CASHIER',
        password: 'cashier-pass-123',
        outletId,
      },
    });
    expect(s.statusCode).toBe(201);
    expect(JSON.stringify(s.json())).not.toContain('password');

    const d = await call('POST', `/v1/outlets/${outletId}/devices`, {
      token: adminToken,
      body: { serial: 'POS-0001', label: 'Pump 1 handset' },
    });
    expect(d.statusCode).toBe(201);

    cashierToken = await login('cash@alpha.test', 'cashier-pass-123');
  });

  it('customer self-registers', async () => {
    const r = await call('POST', '/v1/auth/register', {
      body: {
        name: 'Ravi Kumar',
        email: 'ravi@example.com',
        mobile: '+919876543210',
        password: 'ravi-password-1',
      },
    });
    expect(r.statusCode).toBe(201);
    customerToken = await login('ravi@example.com', 'ravi-password-1');
  });
});

describe('pump flow', () => {
  it('cashier looks up the customer by mobile and sees a masked number', async () => {
    const r = await call('GET', '/v1/points/customers/lookup?mobile=%2B919876543210', {
      token: cashierToken,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      name: 'Ravi Kumar',
      mobileMasked: '+91*******210',
      balance: 0,
    });
  });

  it('earn requires an Idempotency-Key', async () => {
    const r = await call('POST', '/v1/points/earn', {
      token: cashierToken,
      body: { customerMobile: '+919876543210', outletId, amountPaise: 250000, fuelType: 'PETROL' },
    });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('awards points from a registered device and returns a printable slip', async () => {
    const headers = { ...idem(), 'x-device-serial': 'POS-0001' };
    const body = {
      customerMobile: '+919876543210',
      outletId,
      amountPaise: 250000,
      fuelType: 'PETROL',
    };
    const a = await call('POST', '/v1/points/earn', { token: cashierToken, body, headers });
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({ points: 25, balanceAfter: 25, replayed: false });
    expect(a.json().slip.slipNumber).toMatch(/^ALP1-\d{8}-000001$/);

    // network retry with the same key: same answer, no double award
    const b = await call('POST', '/v1/points/earn', { token: cashierToken, body, headers });
    expect(b.json()).toMatchObject({
      replayed: true,
      balanceAfter: 25,
      transactionId: a.json().transactionId,
    });
  });

  it('rejects an unregistered device serial', async () => {
    const r = await call('POST', '/v1/points/earn', {
      token: cashierToken,
      body: { customerMobile: '+919876543210', outletId, amountPaise: 250000, fuelType: 'PETROL' },
      headers: { ...idem(), 'x-device-serial': 'STOLEN-DEVICE' },
    });
    expect(r.statusCode).toBe(403);
  });

  it('customer sees the balance and history; the slip verifies publicly', async () => {
    const w = await call('GET', '/v1/me/wallet', { token: customerToken });
    expect(w.json().balance).toBe(25);

    const h = await call('GET', '/v1/transactions?limit=10', { token: customerToken });
    expect(h.json().items).toHaveLength(1);
    expect(h.json().items[0]).toMatchObject({ type: 'EARN', points: 25 });

    const slip = (
      await call('GET', `/v1/transactions/${h.json().items[0].id}/slip`, { token: customerToken })
    ).json();
    const ok = await call('POST', '/v1/transactions/slips/verify', { body: slip });
    expect(ok.json()).toEqual({ valid: true });
    const forged = await call('POST', '/v1/transactions/slips/verify', {
      body: { ...slip, points: 9999 },
    });
    expect(forged.json()).toEqual({ valid: false });
  });

  it('paginates history with a cursor', async () => {
    for (let i = 0; i < 3; i++) {
      await call('POST', '/v1/points/earn', {
        token: cashierToken,
        body: {
          customerMobile: '+919876543210',
          outletId,
          amountPaise: 100000,
          fuelType: 'DIESEL',
        },
        headers: idem(),
      });
    }
    const p1 = (await call('GET', '/v1/transactions?limit=2', { token: customerToken })).json();
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = (
      await call('GET', `/v1/transactions?limit=2&cursor=${p1.nextCursor}`, {
        token: customerToken,
      })
    ).json();
    expect(p2.items).toHaveLength(2);
    expect(p2.nextCursor).toBeNull();
    const ids = [...p1.items, ...p2.items].map((t: { id: string }) => t.id);
    expect(new Set(ids).size).toBe(4);
  });
});

describe('security', () => {
  it('401 without a token, in the standard error envelope with a request id', async () => {
    const r = await call('GET', '/v1/me/wallet');
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(r.json().error.requestId).toBeTruthy();
    expect(r.headers['x-request-id']).toBe(r.json().error.requestId);
  });

  it('customers cannot award points; cashiers cannot manage staff or adjust', async () => {
    const earn = await call('POST', '/v1/points/earn', {
      token: customerToken,
      body: { customerMobile: '+919876543210', outletId, amountPaise: 250000, fuelType: 'PETROL' },
      headers: idem(),
    });
    expect(earn.statusCode).toBe(403);
    const staff = await call('POST', `/v1/merchants/${merchantId}/staff`, {
      token: cashierToken,
      body: {
        email: 'x@y.test',
        name: 'X Y',
        role: 'CASHIER',
        password: 'password-1234',
        outletId,
      },
    });
    expect(staff.statusCode).toBe(403);
    const adj = await call('POST', '/v1/points/adjust', {
      token: cashierToken,
      body: { customerId: randomUUID(), points: 100, reason: 'cheat' },
      headers: idem(),
    });
    expect(adj.statusCode).toBe(403);
  });

  it("cashiers cannot read another tenant's data", async () => {
    const other = await call('POST', '/v1/merchants', {
      token: adminToken,
      body: { name: 'Beta Petro' },
    });
    const r = await call('GET', `/v1/merchants/${other.json().id}/outlets`, {
      token: cashierToken,
    });
    expect(r.statusCode).toBe(403);
  });

  it('rejects tampered tokens', async () => {
    const r = await call('GET', '/v1/me', { token: cashierToken.slice(0, -3) + 'abc' });
    expect(r.statusCode).toBe(401);
  });

  it('validation errors are structured and never leak internals', async () => {
    const r = await call('POST', '/v1/auth/login', {
      body: { email: 'not-an-email', password: 'x' },
    });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'email' })]),
    );
    expect(JSON.stringify(r.json())).not.toMatch(/stack|node_modules/);
  });

  it('health endpoints are public; metrics are exposed', async () => {
    expect((await call('GET', '/health/live')).statusCode).toBe(200);
    expect((await call('GET', '/health/ready')).statusCode).toBe(200);
    const m = await app.inject({ method: 'GET', url: '/metrics' });
    expect(m.statusCode).toBe(200);
    expect(m.body).toContain('http_request_duration_seconds');
  });

  it('disabling a cashier kills their session', async () => {
    const staff = (
      await call('GET', `/v1/merchants/${merchantId}/staff`, { token: adminToken })
    ).json();
    const cashier = staff.find((s: { role: string }) => s.role === 'CASHIER');
    const d = await call('PATCH', `/v1/staff/${cashier.id}/status`, {
      token: adminToken,
      body: { status: 'DISABLED' },
    });
    expect(d.statusCode).toBe(204);
    const r = await call('POST', '/v1/auth/login', {
      body: { email: 'cash@alpha.test', password: 'cashier-pass-123' },
    });
    expect(r.statusCode).toBe(401);
    const audit = (await call('GET', '/v1/audit', { token: adminToken })).json();
    expect(audit[0]).toMatchObject({ action: 'staff.disabled' });
  });
});
