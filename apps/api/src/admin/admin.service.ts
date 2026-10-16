import { randomUUID } from 'node:crypto';
import { TOPICS } from '@petropoints/contracts';
import { authorize, type Principal, type Role } from '@petropoints/rbac';
import { hashPassword } from '../auth/password';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../common/errors';
import { PG, pgCode, pgConstraint, type Db } from '../db/db';

export interface MerchantRow {
  id: string;
  name: string;
  gstin: string | null;
  status: string;
}
export interface OutletRow {
  id: string;
  merchant_id: string;
  code: string;
  name: string;
  city: string | null;
  status: string;
}
export interface DeviceRow {
  id: string;
  outlet_id: string;
  serial: string;
  label: string | null;
  status: string;
}
export interface StaffRow {
  id: string;
  email: string;
  name: string;
  role: string;
  merchant_id: string;
  outlet_id: string | null;
  status: string;
}

const STAFF_ROLES: Role[] = ['MERCHANT_MANAGER', 'CASHIER'];

export class AdminService {
  constructor(private readonly db: Db) {}

  /* ---- merchants (platform) ---- */

  async createMerchant(p: Principal, input: { name: string; gstin?: string }) {
    this.must(p, 'merchant:manage');
    try {
      return (
        await this.db.query<MerchantRow>(
          'INSERT INTO merchants (name, gstin) VALUES ($1,$2) RETURNING id, name, gstin, status',
          [input.name, input.gstin ?? null],
        )
      ).rows[0]!;
    } catch (e) {
      throw this.conflict(e, 'A merchant with this GSTIN already exists');
    }
  }

  async listMerchants(p: Principal): Promise<MerchantRow[]> {
    this.must(p, 'merchant:read');
    const scoped = p.merchantId && p.role !== 'SUPER_ADMIN';
    const sql = `SELECT id, name, gstin, status FROM merchants ${scoped ? 'WHERE id = $1' : ''} ORDER BY name`;
    return (await this.db.query<MerchantRow>(sql, scoped ? [p.merchantId] : [])).rows;
  }

  async setMerchantStatus(p: Principal, id: string, status: 'ACTIVE' | 'SUSPENDED') {
    this.must(p, 'merchant:manage');
    const r = await this.db.query('UPDATE merchants SET status = $2 WHERE id = $1 RETURNING id', [
      id,
      status,
    ]);
    if (r.rows.length === 0) throw new NotFoundError('Merchant');
    await this.audit(p, `merchant.${status.toLowerCase()}`, 'merchant', id);
  }

  /* ---- outlets ---- */

  async createOutlet(
    p: Principal,
    merchantId: string,
    input: { code: string; name: string; city?: string },
  ) {
    this.must(p, 'outlet:manage', { merchantId });
    try {
      return (
        await this.db.query<OutletRow>(
          `INSERT INTO outlets (merchant_id, code, name, city) VALUES ($1,$2,$3,$4)
           RETURNING id, merchant_id, code, name, city, status`,
          [merchantId, input.code.toUpperCase(), input.name, input.city ?? null],
        )
      ).rows[0]!;
    } catch (e) {
      if (pgCode(e) === PG.UNIQUE_VIOLATION) throw new ConflictError('Outlet code already in use');
      if (pgCode(e) === '23503') throw new NotFoundError('Merchant');
      throw e;
    }
  }

  async listOutlets(p: Principal, merchantId: string): Promise<OutletRow[]> {
    this.must(p, 'outlet:read', { merchantId });
    return (
      await this.db.query<OutletRow>(
        `SELECT id, merchant_id, code, name, city, status FROM outlets WHERE merchant_id = $1 ORDER BY code`,
        [merchantId],
      )
    ).rows;
  }

  /* ---- staff ---- */

  async createStaff(
    p: Principal,
    merchantId: string,
    input: { email: string; name: string; role: Role; password: string; outletId?: string },
  ): Promise<StaffRow> {
    this.must(p, 'staff:manage', { merchantId });
    if (!STAFF_ROLES.includes(input.role))
      throw new ValidationError('Role must be MERCHANT_MANAGER or CASHIER');
    // Privilege escalation guard: a manager can't mint staff, only owners (and platform) can.
    if (p.role === 'MERCHANT_MANAGER') throw new ForbiddenError();

    if (input.role === 'CASHIER') {
      if (!input.outletId) throw new ValidationError('A cashier must be assigned to an outlet');
      const o = await this.db.query('SELECT 1 FROM outlets WHERE id = $1 AND merchant_id = $2', [
        input.outletId,
        merchantId,
      ]);
      if (o.rows.length === 0) throw new NotFoundError('Outlet');
    }
    const hash = await hashPassword(input.password);
    try {
      return await this.db.tx(async (q) => {
        const row = (
          await q.query<StaffRow>(
            `INSERT INTO users (email, name, password_hash, role, merchant_id, outlet_id)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, email, name, role, merchant_id, outlet_id, status`,
            [
              input.email,
              input.name,
              hash,
              input.role,
              merchantId,
              input.role === 'CASHIER' ? input.outletId : null,
            ],
          )
        ).rows[0]!;
        await q.query(
          `INSERT INTO outbox_events (aggregate_id, event_type, topic, payload) VALUES ($1,$2,$3,$4)`,
          [
            row.id,
            'user.registered.v1',
            TOPICS['user.registered.v1'],
            JSON.stringify({
              type: 'user.registered.v1',
              eventId: randomUUID(),
              occurredAt: new Date().toISOString(),
              schemaVersion: 1,
              userId: row.id,
              email: row.email,
              name: row.name,
              role: row.role,
            }),
          ],
        );
        return row;
      });
    } catch (e) {
      throw this.conflict(e, 'Email is already registered');
    }
  }

  async listStaff(p: Principal, merchantId: string): Promise<StaffRow[]> {
    this.must(p, 'staff:read', { merchantId });
    return (
      await this.db.query<StaffRow>(
        `SELECT id, email, name, role, merchant_id, outlet_id, status FROM users
          WHERE merchant_id = $1 ORDER BY name`,
        [merchantId],
      )
    ).rows;
  }

  async setStaffStatus(p: Principal, userId: string, status: 'ACTIVE' | 'DISABLED') {
    const u = (
      await this.db.query<{ merchant_id: string | null; role: string }>(
        'SELECT merchant_id, role FROM users WHERE id = $1',
        [userId],
      )
    ).rows[0];
    if (!u?.merchant_id) throw new NotFoundError('Staff member');
    this.must(p, 'staff:manage', { merchantId: u.merchant_id });
    if (userId === p.userId) throw new ConflictError('You cannot change your own status');
    await this.db.tx(async (q) => {
      await q.query('UPDATE users SET status = $2 WHERE id = $1', [userId, status]);
      // disabling must also kill live sessions
      if (status === 'DISABLED') {
        await q.query(
          'UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
          [userId],
        );
      }
    });
    await this.audit(p, `staff.${status.toLowerCase()}`, 'user', userId);
  }

  /* ---- devices (POS handsets) ---- */

  async registerDevice(p: Principal, outletId: string, input: { serial: string; label?: string }) {
    const outlet = await this.outletMerchant(outletId);
    this.must(p, 'device:manage', { merchantId: outlet });
    try {
      return (
        await this.db.query<DeviceRow>(
          `INSERT INTO devices (outlet_id, serial, label) VALUES ($1,$2,$3)
           RETURNING id, outlet_id, serial, label, status`,
          [outletId, input.serial, input.label ?? null],
        )
      ).rows[0]!;
    } catch (e) {
      throw this.conflict(e, 'Device serial is already registered');
    }
  }

  async listDevices(p: Principal, outletId: string): Promise<DeviceRow[]> {
    const merchantId = await this.outletMerchant(outletId);
    this.must(p, 'device:read', { merchantId });
    return (
      await this.db.query<DeviceRow>(
        'SELECT id, outlet_id, serial, label, status FROM devices WHERE outlet_id = $1 ORDER BY created_at',
        [outletId],
      )
    ).rows;
  }

  async revokeDevice(p: Principal, deviceId: string) {
    const d = (
      await this.db.query<{ merchant_id: string }>(
        'SELECT o.merchant_id FROM devices d JOIN outlets o ON o.id = d.outlet_id WHERE d.id = $1',
        [deviceId],
      )
    ).rows[0];
    if (!d) throw new NotFoundError('Device');
    this.must(p, 'device:manage', { merchantId: d.merchant_id });
    await this.db.query(`UPDATE devices SET status = 'REVOKED' WHERE id = $1`, [deviceId]);
    await this.audit(p, 'device.revoked', 'device', deviceId);
  }

  /** Resolves a POS handset by serial and proves it belongs to the caller's outlet. */
  async assertDeviceForPrincipal(p: Principal, serial: string): Promise<string> {
    const d = (
      await this.db.query<{ id: string; outlet_id: string; status: string }>(
        'SELECT id, outlet_id, status FROM devices WHERE serial = $1',
        [serial],
      )
    ).rows[0];
    if (!d || d.status !== 'ACTIVE') throw new ForbiddenError('Unknown or revoked device');
    if (p.role === 'CASHIER' && d.outlet_id !== p.outletId)
      throw new ForbiddenError('Device belongs to another outlet');
    await this.db.query('UPDATE devices SET last_seen_at = now() WHERE id = $1', [d.id]);
    return d.id;
  }

  /* ---- reports ---- */

  async dailySummary(p: Principal, merchantId: string, days: number) {
    this.must(p, 'report:read', { merchantId });
    return (
      await this.db.query<{
        day: string;
        earned: string;
        redeemed: string;
        sales_paise: string;
        txns: string;
      }>(
        `SELECT to_char((created_at AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS day,
                COALESCE(SUM(points) FILTER (WHERE type = 'EARN'), 0) AS earned,
                COALESCE(-SUM(points) FILTER (WHERE type = 'REDEEM'), 0) AS redeemed,
                COALESCE(SUM(amount_paise) FILTER (WHERE type = 'EARN'), 0) AS sales_paise,
                COUNT(*) AS txns
           FROM transactions
          WHERE merchant_id = $1 AND created_at >= now() - make_interval(days => $2)
          GROUP BY 1 ORDER BY 1`,
        [merchantId, days],
      )
    ).rows.map((r) => ({
      day: r.day,
      earned: Number(r.earned),
      redeemed: Number(r.redeemed),
      salesPaise: Number(r.sales_paise),
      transactions: Number(r.txns),
    }));
  }

  async auditLog(p: Principal, limit: number) {
    this.must(p, 'audit:read');
    return (
      await this.db.query(
        `SELECT id, actor_id, actor_role, action, target_type, target_id, created_at
           FROM audit_log ORDER BY id DESC LIMIT $1`,
        [limit],
      )
    ).rows;
  }

  /* ---- internals ---- */

  private must(p: Principal, perm: Parameters<typeof authorize>[1], res?: { merchantId?: string }) {
    if (!authorize(p, perm, res)) throw new ForbiddenError();
  }

  private async outletMerchant(outletId: string): Promise<string> {
    const r = (
      await this.db.query<{ merchant_id: string }>(
        'SELECT merchant_id FROM outlets WHERE id = $1',
        [outletId],
      )
    ).rows[0];
    if (!r) throw new NotFoundError('Outlet');
    return r.merchant_id;
  }

  private conflict(e: unknown, message: string): unknown {
    return pgCode(e) === PG.UNIQUE_VIOLATION && pgConstraint(e) !== undefined
      ? new ConflictError(message)
      : e;
  }

  private async audit(p: Principal, action: string, targetType: string, targetId: string) {
    await this.db.query(
      'INSERT INTO audit_log (actor_id, actor_role, action, target_type, target_id) VALUES ($1,$2,$3,$4,$5)',
      [p.userId, p.role, action, targetType, targetId],
    );
  }
}
