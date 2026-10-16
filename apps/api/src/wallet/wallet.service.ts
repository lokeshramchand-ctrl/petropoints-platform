import type { Page, TransactionView } from '@petropoints/contracts';
import { authorize, type Principal } from '@petropoints/rbac';
import { ForbiddenError, NotFoundError, ValidationError } from '../common/errors';
import type { Db } from '../db/db';

interface TxnListRow {
  id: string;
  type: TransactionView['type'];
  points: string;
  amount_paise: string | null;
  balance_after: string;
  outlet_id: string | null;
  slip_number: string | null;
  reversal_of: string | null;
  created_at: Date;
}

export interface CustomerLookup {
  customerId: string;
  name: string;
  mobileMasked: string;
  balance: number;
}

function encodeCursor(createdAt: Date, id: string) {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}
function decodeCursor(cursor: string): { at: string; id: string } {
  const [at, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  if (!at || !id || Number.isNaN(Date.parse(at))) throw new ValidationError('Invalid cursor');
  return { at, id };
}

/** Read models: wallet balance, history (keyset pagination) and customer lookup. */
export class WalletService {
  constructor(private readonly db: Db) {}

  async myWallet(
    p: Principal,
  ): Promise<{ balance: number; customerId: string; name: string; mobile: string }> {
    const r = (
      await this.db.query<{ id: string; name: string; mobile: string; balance: string }>(
        `SELECT c.id, c.name, c.mobile, a.balance FROM customers c
           JOIN accounts a ON a.customer_id = c.id AND a.kind = 'CUSTOMER_WALLET'
          WHERE c.user_id = $1`,
        [p.userId],
      )
    ).rows[0];
    if (!r) throw new NotFoundError('Wallet');
    return { customerId: r.id, name: r.name, mobile: r.mobile, balance: Number(r.balance) };
  }

  /**
   * Keyset pagination on (created_at, id): O(log n) per page regardless of depth, stable under inserts.
   * Row visibility is derived from the caller's role scope, never from client-supplied filters.
   */
  async history(
    p: Principal,
    opts: { cursor?: string; limit: number; customerId?: string },
  ): Promise<Page<TransactionView>> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };

    switch (p.role) {
      case 'CUSTOMER':
        add('t.customer_id = (SELECT id FROM customers WHERE user_id = ?)', p.userId);
        break;
      case 'CASHIER':
        add('t.outlet_id = ?', p.outletId);
        break;
      case 'MERCHANT_OWNER':
      case 'MERCHANT_MANAGER':
        add('t.merchant_id = ?', p.merchantId);
        break;
      default:
        if (opts.customerId) add('t.customer_id = ?', opts.customerId);
    }
    if (opts.cursor) {
      const c = decodeCursor(opts.cursor);
      params.push(c.at, c.id);
      where.push(
        `(t.created_at, t.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
      );
    }
    params.push(opts.limit + 1);

    const rows = (
      await this.db.query<TxnListRow>(
        `SELECT t.id, t.type, t.points, t.amount_paise, t.balance_after, t.outlet_id, t.slip_number,
                t.reversal_of, t.created_at
           FROM transactions t
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY t.created_at DESC, t.id DESC
          LIMIT $${params.length}`,
        params,
      )
    ).rows;

    const hasMore = rows.length > opts.limit;
    const pageRows = hasMore ? rows.slice(0, opts.limit) : rows;
    const last = pageRows.at(-1);
    return {
      items: pageRows.map((r) => ({
        id: r.id,
        type: r.type,
        points: Number(r.points),
        amountPaise: r.amount_paise === null ? null : Number(r.amount_paise),
        balanceAfter: Number(r.balance_after),
        outletId: r.outlet_id,
        slipNumber: r.slip_number,
        reversalOf: r.reversal_of,
        createdAt: new Date(r.created_at).toISOString(),
      })),
      nextCursor: hasMore && last ? encodeCursor(new Date(last.created_at), last.id) : null,
    };
  }

  /** Cashier-facing lookup by mobile. Reveals only what's needed at the pump. */
  async lookupByMobile(p: Principal, mobile: string): Promise<CustomerLookup> {
    if (!authorize(p, 'customer:read')) throw new ForbiddenError();
    const r = (
      await this.db.query<{ id: string; name: string; mobile: string; balance: string }>(
        `SELECT c.id, c.name, c.mobile, a.balance FROM customers c
           JOIN accounts a ON a.customer_id = c.id AND a.kind = 'CUSTOMER_WALLET'
          WHERE c.mobile = $1`,
        [mobile],
      )
    ).rows[0];
    if (!r) throw new NotFoundError('Customer');
    const masked = `${r.mobile.slice(0, 3)}${'*'.repeat(r.mobile.length - 6)}${r.mobile.slice(-3)}`;
    return { customerId: r.id, name: r.name, mobileMasked: masked, balance: Number(r.balance) };
  }
}
