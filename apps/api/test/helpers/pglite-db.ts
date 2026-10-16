import { PGlite } from '@electric-sql/pglite';
import type { Db, Queryable } from '../../src/db/db';

/** In-process real PostgreSQL (WASM) for fast, Docker-free integration tests. */
export class PgliteDb implements Db {
  constructor(private readonly pg: PGlite) {}

  static async create(): Promise<PgliteDb> {
    const pg = new PGlite();
    await pg.waitReady;
    return new PgliteDb(pg);
  }

  query<R>(sql: string, params?: unknown[]) {
    return this.pg.query(sql, params) as unknown as Promise<{ rows: R[] }>;
  }

  async exec(sql: string) {
    await this.pg.exec(sql);
  }

  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    return this.pg.transaction((t) =>
      fn({ query: (sql, params) => t.query(sql, params) as unknown as Promise<{ rows: never[] }> }),
    );
  }

  close() {
    return this.pg.close();
  }
}
