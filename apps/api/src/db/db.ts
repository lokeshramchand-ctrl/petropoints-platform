/**
 * Minimal database port. The domain layer depends on this, not on `pg`, so the same code runs on a
 * pooled PostgreSQL connection in production and on in-process PGlite in tests.
 */
export interface QueryResult<R> {
  rows: R[];
}

export interface Queryable {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<R>>;
}

export interface Db extends Queryable {
  /** Runs `fn` in one transaction; commits on resolve, rolls back on throw. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  /** Runs multi-statement SQL (migrations). */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

/** PostgreSQL error codes we react to. */
export const PG = {
  UNIQUE_VIOLATION: '23505',
  CHECK_VIOLATION: '23514',
  INTEGRITY_VIOLATION: '23000',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK: '40P01',
} as const;

export function pgCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

export function pgConstraint(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'constraint' in err
    ? String((err as { constraint: unknown }).constraint)
    : undefined;
}
