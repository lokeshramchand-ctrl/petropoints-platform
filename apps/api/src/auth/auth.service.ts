import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import {
  TOPICS,
  type LoginRequest,
  type RegisterCustomerRequest,
  type TokenPair,
} from '@petropoints/contracts';
import { isRole, type Principal, type Role } from '@petropoints/rbac';
import { AccountLockedError, ConflictError, UnauthorizedError } from '../common/errors';
import { PG, pgCode, pgConstraint, type Db, type Queryable } from '../db/db';
import { hashPassword, verifyDummy, verifyPassword } from './password';

export interface AuthConfig {
  accessSecret: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
}

export const MAX_FAILED_LOGINS = 5;
export const LOCK_MINUTES = 15;

interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  role: string;
  merchant_id: string | null;
  outlet_id: string | null;
  status: string;
  failed_logins: number;
  locked_until: Date | null;
}

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

export class AuthService {
  private readonly key: Uint8Array;

  constructor(
    private readonly db: Db,
    private readonly cfg: AuthConfig,
  ) {
    this.key = new TextEncoder().encode(cfg.accessSecret);
  }

  async registerCustomer(
    req: RegisterCustomerRequest,
  ): Promise<{ userId: string; customerId: string }> {
    const passwordHash = await hashPassword(req.password);
    try {
      return await this.db.tx(async (q) => {
        const user = (
          await q.query<{ id: string }>(
            `INSERT INTO users (email, mobile, name, password_hash, role)
             VALUES ($1,$2,$3,$4,'CUSTOMER') RETURNING id`,
            [req.email, req.mobile, req.name, passwordHash],
          )
        ).rows[0]!;
        const customer = (
          await q.query<{ id: string }>(
            `INSERT INTO customers (user_id, mobile, name, city) VALUES ($1,$2,$3,$4) RETURNING id`,
            [user.id, req.mobile, req.name, req.city ?? null],
          )
        ).rows[0]!;
        await q.query(`INSERT INTO accounts (kind, customer_id) VALUES ('CUSTOMER_WALLET', $1)`, [
          customer.id,
        ]);
        // welcome email is delivered asynchronously by the notifications consumer
        await q.query(
          `INSERT INTO outbox_events (aggregate_id, event_type, topic, payload) VALUES ($1,$2,$3,$4)`,
          [
            user.id,
            'user.registered.v1',
            TOPICS['user.registered.v1'],
            JSON.stringify({
              type: 'user.registered.v1',
              eventId: randomUUID(),
              occurredAt: new Date().toISOString(),
              schemaVersion: 1,
              userId: user.id,
              email: req.email,
              name: req.name,
              role: 'CUSTOMER',
            }),
          ],
        );
        return { userId: user.id, customerId: customer.id };
      });
    } catch (err) {
      if (pgCode(err) === PG.UNIQUE_VIOLATION) {
        const c = pgConstraint(err) ?? '';
        throw new ConflictError(
          c.includes('mobile')
            ? 'Mobile number is already registered'
            : 'Email is already registered',
        );
      }
      throw err;
    }
  }

  async login(
    req: LoginRequest,
  ): Promise<{ tokens: TokenPair; principal: Principal; name: string }> {
    const user = (
      await this.db.query<UserRow>('SELECT * FROM users WHERE lower(email) = $1', [req.email])
    ).rows[0];

    if (!user) {
      await verifyDummy(req.password);
      throw new UnauthorizedError();
    }
    if (user.locked_until && user.locked_until.getTime() > Date.now()) {
      throw new AccountLockedError(user.locked_until);
    }

    const ok = await verifyPassword(req.password, user.password_hash);
    if (!ok || user.status !== 'ACTIVE') {
      if (!ok) await this.recordFailure(user);
      throw new UnauthorizedError();
    }

    await this.db.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [
      user.id,
    ]);
    const principal = this.principalOf(user);
    const tokens = await this.db.tx((q) => this.issue(q, user, randomUUID()));
    return { tokens, principal, name: user.name };
  }

  /** Rotating refresh tokens. Re-presenting a spent token revokes the whole family (theft signal). */
  async refresh(refreshToken: string): Promise<TokenPair> {
    // A reuse detection must survive even though we then throw, so we commit the revocation first.
    const outcome = await this.db.tx(async (q) => {
      const row = (
        await q.query<{
          id: string;
          user_id: string;
          family_id: string;
          expires_at: Date;
          used_at: Date | null;
          revoked_at: Date | null;
        }>('SELECT * FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE', [sha256(refreshToken)])
      ).rows[0];
      if (!row) return { kind: 'invalid' as const };

      if (row.used_at || row.revoked_at) {
        await q.query(
          'UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL',
          [row.family_id],
        );
        return { kind: 'reuse' as const };
      }
      if (row.expires_at.getTime() < Date.now()) return { kind: 'invalid' as const };

      const user = (await q.query<UserRow>('SELECT * FROM users WHERE id = $1', [row.user_id]))
        .rows[0];
      if (!user || user.status !== 'ACTIVE') return { kind: 'invalid' as const };

      await q.query('UPDATE refresh_tokens SET used_at = now() WHERE id = $1', [row.id]);
      return { kind: 'ok' as const, tokens: await this.issue(q, user, row.family_id) };
    });

    if (outcome.kind !== 'ok') throw new UnauthorizedError('Session expired, please sign in again');
    return outcome.tokens;
  }

  async logout(refreshToken: string): Promise<void> {
    await this.db.query(
      `UPDATE refresh_tokens SET revoked_at = now()
        WHERE family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1)
          AND revoked_at IS NULL`,
      [sha256(refreshToken)],
    );
  }

  async verifyAccessToken(token: string): Promise<Principal> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ['HS256'],
        issuer: 'petropoints',
        audience: 'petropoints-api',
      });
      if (!payload.sub || !isRole(payload.role)) throw new Error('bad claims');
      return {
        userId: payload.sub,
        role: payload.role,
        merchantId: (payload.mid as string | undefined) ?? null,
        outletId: (payload.oid as string | undefined) ?? null,
      };
    } catch {
      throw new UnauthorizedError('Invalid or expired token');
    }
  }

  /* ----------------------------------------------------------------------- */

  private async recordFailure(user: UserRow) {
    const failures = user.failed_logins + 1;
    const lock = failures >= MAX_FAILED_LOGINS;
    await this.db.query(
      `UPDATE users SET failed_logins = $2,
              locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) ELSE locked_until END
        WHERE id = $1`,
      [user.id, lock ? 0 : failures, lock, LOCK_MINUTES],
    );
  }

  private principalOf(u: UserRow): Principal {
    return {
      userId: u.id,
      role: u.role as Role,
      merchantId: u.merchant_id,
      outletId: u.outlet_id,
    };
  }

  private async issue(q: Queryable, user: UserRow, familyId: string): Promise<TokenPair> {
    const accessToken = await new SignJWT({
      role: user.role,
      ...(user.merchant_id && { mid: user.merchant_id }),
      ...(user.outlet_id && { oid: user.outlet_id }),
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(user.id)
      .setIssuer('petropoints')
      .setAudience('petropoints-api')
      .setIssuedAt()
      .setJti(randomUUID())
      .setExpirationTime(`${this.cfg.accessTtlSeconds}s`)
      .sign(this.key);

    const refreshToken = randomBytes(32).toString('base64url');
    await q.query(
      `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at)
       VALUES ($1,$2,$3, now() + make_interval(secs => $4))`,
      [user.id, familyId, sha256(refreshToken), this.cfg.refreshTtlSeconds],
    );
    return { accessToken, refreshToken, expiresInSeconds: this.cfg.accessTtlSeconds };
  }
}
