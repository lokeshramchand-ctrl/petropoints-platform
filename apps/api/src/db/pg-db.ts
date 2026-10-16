import { Pool, type PoolConfig } from 'pg';
import { PG, pgCode, type Db, type Queryable } from './db';

const MAX_TX_ATTEMPTS = 3;

export class PgDb implements Db {
  private readonly pool: Pool;

  constructor(config: PoolConfig) {
    this.pool = new Pool({
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ...config,
    });
  }

  query<R>(sql: string, params?: unknown[]) {
    return this.pool.query(sql, params as unknown[]) as unknown as Promise<{ rows: R[] }>;
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  /** Retries transient serialization failures / deadlocks, which are expected under contention. */
  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({
          query: (sql, params) =>
            client.query(sql, params as unknown[]) as unknown as Promise<{ rows: never[] }>,
        });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        const code = pgCode(err);
        const transient = code === PG.SERIALIZATION_FAILURE || code === PG.DEADLOCK;
        if (!transient || attempt >= MAX_TX_ATTEMPTS) throw err;
      } finally {
        client.release();
      }
    }
  }

  close() {
    return this.pool.end();
  }
}
