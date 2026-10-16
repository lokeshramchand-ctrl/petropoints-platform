import { createHash, randomUUID } from 'node:crypto';
import {
  TOPICS,
  maskMobile,
  pointsForSpend,
  type DomainEvent,
  type EarnPointsRequest,
  type RedeemPointsRequest,
  type SlipView,
  type TxnType,
} from '@petropoints/contracts';
import { authorize, type Permission, type Principal, type ResourceRef } from '@petropoints/rbac';
import {
  AlreadyReversedError,
  ConflictError,
  ForbiddenError,
  IdempotencyConflictError,
  InsufficientPointsError,
  NotFoundError,
  ValidationError,
} from '../common/errors';
import { PG, pgCode, pgConstraint, type Db, type Queryable } from '../db/db';
import { signSlip } from './slip';

export interface LedgerConfig {
  slipHmacSecret: string;
  paisePerPoint?: number;
}

export interface Actor extends Principal {
  deviceId?: string | null;
}

export interface CommandResult {
  transactionId: string;
  type: TxnType;
  points: number;
  balanceAfter: number;
  slip: SlipView | null;
  /** true when this response replays an earlier identical request */
  replayed: boolean;
}

interface TxnRow {
  id: string;
  type: TxnType;
  customer_id: string;
  merchant_id: string | null;
  outlet_id: string | null;
  points: string;
  amount_paise: string | null;
  fuel_type: string | null;
  reversal_of: string | null;
  slip_number: string | null;
  balance_after: string;
  request_hash: string;
  created_at: Date;
}

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

export class LedgerService {
  constructor(
    private readonly db: Db,
    private readonly cfg: LedgerConfig,
  ) {}

  /* ------------------------------------------------------------------ commands */

  async earn(actor: Actor, idempotencyKey: string, req: EarnPointsRequest): Promise<CommandResult> {
    return this.db.tx(async (q) => {
      const requestHash = hash(['EARN', req]);
      const replay = await this.findReplay(q, actor, idempotencyKey, requestHash);
      if (replay) return replay;

      const outlet = await this.loadOutlet(q, req.outletId);
      this.assertAllowed(actor, 'points:earn', {
        merchantId: outlet.merchant_id,
        outletId: outlet.id,
      });

      const points = pointsForSpend(req.amountPaise, this.cfg.paisePerPoint);
      if (points < 1) {
        throw new ValidationError('Amount is below the minimum needed to earn a point');
      }

      const customer = await this.customerByMobile(q, req.customerMobile);
      const wallet = await this.lockWallet(q, customer.id);
      const balanceAfter = Number(wallet.balance) + points;
      const slipNumber = await this.nextSlip(q, outlet.id, outlet.code);

      const txnId = await this.insertTxn(q, {
        type: 'EARN',
        customerId: customer.id,
        merchantId: outlet.merchant_id,
        outletId: outlet.id,
        actor,
        idempotencyKey,
        requestHash,
        points,
        amountPaise: req.amountPaise,
        fuelType: req.fuelType,
        quantityMl: req.quantityMilliLitres ?? null,
        slipNumber,
        balanceAfter,
      });
      await this.postEntries(q, txnId, [
        [await this.systemAccount(q, 'PROGRAM_ISSUANCE'), -points],
        [wallet.id, points],
      ]);
      await this.applyWalletBalance(q, wallet.id, points);

      await this.emit(q, txnId, {
        type: 'points.earned.v1',
        eventId: randomUUID(),
        occurredAt: new Date().toISOString(),
        schemaVersion: 1,
        transactionId: txnId,
        customerId: customer.id,
        merchantId: outlet.merchant_id,
        outletId: outlet.id,
        points,
        amountPaise: req.amountPaise,
        fuelType: req.fuelType,
      });
      return this.result(q, txnId, slipNumber, false);
    });
  }

  async redeem(
    actor: Actor,
    idempotencyKey: string,
    req: RedeemPointsRequest,
  ): Promise<CommandResult> {
    return this.db.tx(async (q) => {
      const requestHash = hash(['REDEEM', req]);
      const replay = await this.findReplay(q, actor, idempotencyKey, requestHash);
      if (replay) return replay;

      const outlet = await this.loadOutlet(q, req.outletId);
      this.assertAllowed(actor, 'points:redeem', {
        merchantId: outlet.merchant_id,
        outletId: outlet.id,
      });

      const customer = await this.customerByMobile(q, req.customerMobile);
      const wallet = await this.lockWallet(q, customer.id);
      const available = Number(wallet.balance);
      if (available < req.points) throw new InsufficientPointsError(available, req.points);
      const slipNumber = await this.nextSlip(q, outlet.id, outlet.code);

      const txnId = await this.insertTxn(q, {
        type: 'REDEEM',
        customerId: customer.id,
        merchantId: outlet.merchant_id,
        outletId: outlet.id,
        actor,
        idempotencyKey,
        requestHash,
        points: -req.points,
        slipNumber,
        balanceAfter: available - req.points,
      });
      await this.postEntries(q, txnId, [
        [wallet.id, -req.points],
        [await this.systemAccount(q, 'PROGRAM_REDEMPTION'), req.points],
      ]);
      await this.applyWalletBalance(q, wallet.id, -req.points);

      await this.emit(q, txnId, {
        type: 'points.redeemed.v1',
        eventId: randomUUID(),
        occurredAt: new Date().toISOString(),
        schemaVersion: 1,
        transactionId: txnId,
        customerId: customer.id,
        merchantId: outlet.merchant_id,
        outletId: outlet.id,
        points: req.points,
      });
      return this.result(q, txnId, slipNumber, false);
    });
  }

  /** Undo an EARN or REDEEM by posting the exact opposite entries. History is never edited. */
  async reverse(
    actor: Actor,
    idempotencyKey: string,
    originalId: string,
    reason: string,
  ): Promise<CommandResult> {
    try {
      return await this.db.tx(async (q) => {
        const requestHash = hash(['REVERSAL', originalId, reason]);
        const replay = await this.findReplay(q, actor, idempotencyKey, requestHash);
        if (replay) return replay;

        const original = (
          await q.query<TxnRow>('SELECT * FROM transactions WHERE id = $1', [originalId])
        ).rows[0];
        if (!original) throw new NotFoundError('Transaction');
        if (original.type !== 'EARN' && original.type !== 'REDEEM') {
          throw new ValidationError(`A ${original.type} transaction cannot be reversed`);
        }
        this.assertAllowed(actor, 'points:reverse', {
          merchantId: original.merchant_id ?? undefined,
          outletId: original.outlet_id ?? undefined,
        });

        // Checked under the wallet lock, so concurrent reversals of one transaction serialise here.
        const wallet = await this.lockWallet(q, original.customer_id);
        const prior = await q.query('SELECT 1 FROM transactions WHERE reversal_of = $1', [
          original.id,
        ]);
        if (prior.rows.length > 0) throw new AlreadyReversedError();
        const effect = -Number(original.points);
        const balanceAfter = Number(wallet.balance) + effect;
        if (balanceAfter < 0) throw new InsufficientPointsError(Number(wallet.balance), -effect);

        const txnId = await this.insertTxn(q, {
          type: 'REVERSAL',
          customerId: original.customer_id,
          merchantId: original.merchant_id,
          outletId: original.outlet_id,
          actor,
          idempotencyKey,
          requestHash,
          points: effect,
          reversalOf: original.id,
          reason,
          balanceAfter,
        });
        const counter = await this.systemAccount(
          q,
          original.type === 'EARN' ? 'PROGRAM_ISSUANCE' : 'PROGRAM_REDEMPTION',
        );
        await this.postEntries(q, txnId, [
          [wallet.id, effect],
          [counter, -effect],
        ]);
        await this.applyWalletBalance(q, wallet.id, effect);

        await this.emit(q, txnId, {
          type: 'points.reversed.v1',
          eventId: randomUUID(),
          occurredAt: new Date().toISOString(),
          schemaVersion: 1,
          transactionId: txnId,
          originalTransactionId: original.id,
          customerId: original.customer_id,
          points: effect,
          reason,
          ...(original.merchant_id && { merchantId: original.merchant_id }),
          ...(original.outlet_id && { outletId: original.outlet_id }),
          originalType: original.type as 'EARN' | 'REDEEM',
          ...(original.amount_paise && { amountPaise: Number(original.amount_paise) }),
        });
        return this.result(q, txnId, null, false);
      });
    } catch (err) {
      // unique(reversal_of) is the arbiter when two reversals race
      if (pgCode(err) === PG.UNIQUE_VIOLATION && pgConstraint(err)?.includes('reversal_of')) {
        throw new AlreadyReversedError();
      }
      throw err;
    }
  }

  /** Manual correction. Restricted to roles with `points:adjust` (SUPER_ADMIN). */
  async adjust(
    actor: Actor,
    idempotencyKey: string,
    customerId: string,
    delta: number,
    reason: string,
  ): Promise<CommandResult> {
    return this.db.tx(async (q) => {
      const requestHash = hash(['ADJUSTMENT', customerId, delta, reason]);
      const replay = await this.findReplay(q, actor, idempotencyKey, requestHash);
      if (replay) return replay;
      this.assertAllowed(actor, 'points:adjust');

      const exists = (await q.query('SELECT 1 FROM customers WHERE id = $1', [customerId])).rows[0];
      if (!exists) throw new NotFoundError('Customer');

      const wallet = await this.lockWallet(q, customerId);
      const balanceAfter = Number(wallet.balance) + delta;
      if (balanceAfter < 0) throw new InsufficientPointsError(Number(wallet.balance), -delta);

      const txnId = await this.insertTxn(q, {
        type: 'ADJUSTMENT',
        customerId,
        merchantId: null,
        outletId: null,
        actor,
        idempotencyKey,
        requestHash,
        points: delta,
        reason,
        balanceAfter,
      });
      await this.postEntries(q, txnId, [
        [wallet.id, delta],
        [await this.systemAccount(q, 'PROGRAM_ADJUSTMENT'), -delta],
      ]);
      await this.applyWalletBalance(q, wallet.id, delta);
      return this.result(q, txnId, null, false);
    });
  }

  /* ------------------------------------------------------------------ queries */

  async getSlip(actor: Actor, transactionId: string): Promise<SlipView> {
    return this.db.tx(async (q) => {
      const owner = (
        await q.query<{
          merchant_id: string | null;
          outlet_id: string | null;
          owner_user_id: string;
        }>(
          `SELECT t.merchant_id, t.outlet_id, c.user_id AS owner_user_id
             FROM transactions t JOIN customers c ON c.id = t.customer_id WHERE t.id = $1`,
          [transactionId],
        )
      ).rows[0];
      // Same response for "missing" and "not yours": don't leak which transaction ids exist.
      if (
        !owner ||
        !authorize(actor, 'transaction:read', {
          ownerUserId: owner.owner_user_id,
          merchantId: owner.merchant_id ?? undefined,
          outletId: owner.outlet_id ?? undefined,
        })
      ) {
        throw new NotFoundError('Slip');
      }
      const view = await this.loadSlip(q, transactionId);
      if (!view) throw new NotFoundError('Slip');
      return view.slip;
    });
  }

  /* ------------------------------------------------------------------ internals */

  private assertAllowed(actor: Actor, permission: Permission, resource?: ResourceRef) {
    if (!authorize(actor, permission, resource)) throw new ForbiddenError();
  }

  private async findReplay(
    q: Queryable,
    actor: Actor,
    key: string,
    requestHash: string,
  ): Promise<CommandResult | null> {
    const row = (
      await q.query<TxnRow>(
        'SELECT * FROM transactions WHERE actor_user_id = $1 AND idempotency_key = $2',
        [actor.userId, key],
      )
    ).rows[0];
    if (!row) return null;
    if (row.request_hash !== requestHash) throw new IdempotencyConflictError();
    return this.result(q, row.id, row.slip_number, true);
  }

  private async loadOutlet(q: Queryable, id: string) {
    const outlet = (
      await q.query<{
        id: string;
        merchant_id: string;
        code: string;
        status: string;
        mstatus: string;
      }>(
        `SELECT o.id, o.merchant_id, o.code, o.status, m.status AS mstatus
           FROM outlets o JOIN merchants m ON m.id = o.merchant_id WHERE o.id = $1`,
        [id],
      )
    ).rows[0];
    if (!outlet) throw new NotFoundError('Outlet');
    if (outlet.status !== 'ACTIVE' || outlet.mstatus !== 'ACTIVE') {
      throw new ConflictError('Outlet is suspended');
    }
    return outlet;
  }

  private async customerByMobile(q: Queryable, mobile: string) {
    const c = (
      await q.query<{ id: string }>('SELECT id FROM customers WHERE mobile = $1', [mobile])
    ).rows[0];
    if (!c) throw new NotFoundError('Customer');
    return c;
  }

  /** Row lock serialises concurrent writers on ONE wallet only; other customers are unaffected. */
  private async lockWallet(q: Queryable, customerId: string) {
    const w = (
      await q.query<{ id: string; balance: string }>(
        `SELECT id, balance FROM accounts WHERE customer_id = $1 AND kind = 'CUSTOMER_WALLET' FOR UPDATE`,
        [customerId],
      )
    ).rows[0];
    if (!w) throw new NotFoundError('Wallet');
    return w;
  }

  private async systemAccount(q: Queryable, kind: string): Promise<string> {
    const row = (await q.query<{ id: string }>('SELECT id FROM accounts WHERE kind = $1', [kind]))
      .rows[0];
    if (!row) throw new Error(`System account ${kind} missing: run migrations`);
    return row.id;
  }

  private async insertTxn(
    q: Queryable,
    t: {
      type: TxnType;
      customerId: string;
      merchantId: string | null;
      outletId: string | null;
      actor: Actor;
      idempotencyKey: string;
      requestHash: string;
      points: number;
      amountPaise?: number;
      fuelType?: string;
      quantityMl?: number | null;
      reversalOf?: string;
      reason?: string;
      slipNumber?: string;
      balanceAfter: number;
    },
  ): Promise<string> {
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO transactions
         (type, customer_id, merchant_id, outlet_id, device_id, actor_user_id, idempotency_key, request_hash,
          points, amount_paise, fuel_type, quantity_ml, reversal_of, reason, slip_number, balance_after)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      [
        t.type,
        t.customerId,
        t.merchantId,
        t.outletId,
        t.actor.deviceId ?? null,
        t.actor.userId,
        t.idempotencyKey,
        t.requestHash,
        t.points,
        t.amountPaise ?? null,
        t.fuelType ?? null,
        t.quantityMl ?? null,
        t.reversalOf ?? null,
        t.reason ?? null,
        t.slipNumber ?? null,
        t.balanceAfter,
      ],
    );
    return rows[0]!.id;
  }

  private async postEntries(q: Queryable, txnId: string, entries: Array<[string, number]>) {
    // Sum must be zero; the deferred DB constraint trigger re-checks this at COMMIT.
    for (const [accountId, delta] of entries) {
      await q.query(
        'INSERT INTO ledger_entries (transaction_id, account_id, delta) VALUES ($1,$2,$3)',
        [txnId, accountId, delta],
      );
    }
  }

  private async applyWalletBalance(q: Queryable, walletId: string, delta: number) {
    // CHECK (balance >= 0) is the last line of defence against overdraft.
    await q.query(
      'UPDATE accounts SET balance = balance + $2, version = version + 1 WHERE id = $1',
      [walletId, delta],
    );
  }

  /**
   * Allocates the next slip number for an outlet. Done after the wallet lock and right before the
   * insert so the per-outlet counter row lock is held briefly. Gaps are possible only on rollback.
   */
  private async nextSlip(q: Queryable, outletId: string, code: string): Promise<string> {
    const { rows } = await q.query<{ last_seq: string }>(
      `INSERT INTO outlet_slip_counters (outlet_id, last_seq) VALUES ($1, 1)
         ON CONFLICT (outlet_id) DO UPDATE SET last_seq = outlet_slip_counters.last_seq + 1
       RETURNING last_seq`,
      [outletId],
    );
    const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    return `${code}-${day}-${String(rows[0]!.last_seq).padStart(6, '0')}`;
  }

  private async emit(q: Queryable, txnId: string, event: DomainEvent) {
    await q.query(
      `INSERT INTO outbox_events (aggregate_id, event_type, topic, payload) VALUES ($1,$2,$3,$4)`,
      [txnId, event.type, TOPICS[event.type], JSON.stringify(event)],
    );
  }

  private async result(
    q: Queryable,
    txnId: string,
    slipNumber: string | null,
    replayed: boolean,
  ): Promise<CommandResult> {
    const row = (await q.query<TxnRow>('SELECT * FROM transactions WHERE id = $1', [txnId]))
      .rows[0]!;
    const slip = slipNumber ? ((await this.loadSlip(q, txnId))?.slip ?? null) : null;
    return {
      transactionId: txnId,
      type: row.type,
      points: Number(row.points),
      balanceAfter: Number(row.balance_after),
      slip,
      replayed,
    };
  }

  private async loadSlip(q: Queryable, txnId: string): Promise<{ slip: SlipView } | null> {
    const r = (
      await q.query<{
        id: string;
        type: TxnType;
        points: string;
        amount_paise: string | null;
        balance_after: string;
        slip_number: string | null;
        created_at: Date;
        merchant_name: string | null;
        outlet_name: string | null;
        customer_name: string;
        customer_mobile: string;
      }>(
        `SELECT t.id, t.type, t.points, t.amount_paise, t.balance_after, t.slip_number, t.created_at,
                m.name AS merchant_name, o.name AS outlet_name, c.name AS customer_name, c.mobile AS customer_mobile
           FROM transactions t
           JOIN customers c ON c.id = t.customer_id
           LEFT JOIN outlets o ON o.id = t.outlet_id
           LEFT JOIN merchants m ON m.id = t.merchant_id
          WHERE t.id = $1`,
        [txnId],
      )
    ).rows[0];
    if (!r || !r.slip_number) return null;
    const createdAt = new Date(r.created_at).toISOString();
    const points = Number(r.points);
    return {
      slip: {
        slipNumber: r.slip_number,
        transactionId: r.id,
        type: r.type,
        merchantName: r.merchant_name ?? 'PetroPoints',
        outletName: r.outlet_name ?? '',
        customerName: r.customer_name,
        customerMobileMasked: maskMobile(r.customer_mobile),
        points,
        balanceAfter: Number(r.balance_after),
        amountPaise: r.amount_paise === null ? null : Number(r.amount_paise),
        createdAt,
        signature: signSlip(this.cfg.slipHmacSecret, {
          slipNumber: r.slip_number,
          transactionId: r.id,
          points,
          createdAt,
        }),
      },
    };
  }
}
