import type { Db } from '../../src/db/db';
import type { Actor } from '../../src/ledger/ledger.service';

export interface World {
  merchantA: string;
  merchantB: string;
  outletA1: string;
  outletA2: string;
  outletB1: string;
  cashierA1: Actor;
  cashierA2: Actor;
  ownerA: Actor;
  ownerB: Actor;
  support: Actor;
  superAdmin: Actor;
  customerId: string;
  customerMobile: string;
  customerActor: Actor;
}

async function one<T>(db: Db, sql: string, params: unknown[]): Promise<T> {
  return (await db.query<T>(sql, params)).rows[0]!;
}

export async function seedWorld(db: Db): Promise<World> {
  const merchant = (name: string) =>
    one<{ id: string }>(db, 'INSERT INTO merchants (name) VALUES ($1) RETURNING id', [name]).then(
      (r) => r.id,
    );
  const outlet = (merchantId: string, code: string) =>
    one<{ id: string }>(
      db,
      `INSERT INTO outlets (merchant_id, code, name, city) VALUES ($1,$2,$3,'Chennai') RETURNING id`,
      [merchantId, code, `Outlet ${code}`],
    ).then((r) => r.id);
  const user = (
    email: string,
    role: string,
    merchantId: string | null,
    outletId: string | null,
    mobile: string | null = null,
  ) =>
    one<{ id: string }>(
      db,
      `INSERT INTO users (email, mobile, name, password_hash, role, merchant_id, outlet_id)
       VALUES ($1,$2,$1,'x',$3,$4,$5) RETURNING id`,
      [email, mobile, role, merchantId, outletId],
    ).then((r) => r.id);

  const merchantA = await merchant('Alpha Fuels');
  const merchantB = await merchant('Beta Petro');
  const outletA1 = await outlet(merchantA, 'ALP1');
  const outletA2 = await outlet(merchantA, 'ALP2');
  const outletB1 = await outlet(merchantB, 'BET1');

  const customerMobile = '+919876543210';
  const customerUser = await user('cust@x.test', 'CUSTOMER', null, null, customerMobile);
  const customer = await one<{ id: string }>(
    db,
    `INSERT INTO customers (user_id, mobile, name) VALUES ($1,$2,'Ravi Kumar') RETURNING id`,
    [customerUser, customerMobile],
  );
  await db.query(`INSERT INTO accounts (kind, customer_id) VALUES ('CUSTOMER_WALLET', $1)`, [
    customer.id,
  ]);

  return {
    merchantA,
    merchantB,
    outletA1,
    outletA2,
    outletB1,
    cashierA1: {
      userId: await user('c1@x.test', 'CASHIER', merchantA, outletA1),
      role: 'CASHIER',
      merchantId: merchantA,
      outletId: outletA1,
    },
    cashierA2: {
      userId: await user('c2@x.test', 'CASHIER', merchantA, outletA2),
      role: 'CASHIER',
      merchantId: merchantA,
      outletId: outletA2,
    },
    ownerA: {
      userId: await user('oa@x.test', 'MERCHANT_OWNER', merchantA, null),
      role: 'MERCHANT_OWNER',
      merchantId: merchantA,
    },
    ownerB: {
      userId: await user('ob@x.test', 'MERCHANT_OWNER', merchantB, null),
      role: 'MERCHANT_OWNER',
      merchantId: merchantB,
    },
    support: { userId: await user('s@x.test', 'SUPPORT_AGENT', null, null), role: 'SUPPORT_AGENT' },
    superAdmin: {
      userId: await user('sa@x.test', 'SUPER_ADMIN', null, null),
      role: 'SUPER_ADMIN',
    },
    customerId: customer.id,
    customerMobile,
    customerActor: { userId: customerUser, role: 'CUSTOMER' },
  };
}
