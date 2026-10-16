import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './db';

export const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

interface Applied {
  name: string;
  checksum: string;
}

/**
 * Forward-only migrations. Each file runs in its own transaction and its checksum is recorded:
 * editing an already-applied migration is detected and refused, forcing a new migration instead.
 */
export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);

  const applied = new Map(
    (await db.query<Applied>('SELECT name, checksum FROM schema_migrations')).rows.map((r) => [
      r.name,
      r.checksum,
    ]),
  );

  const files = readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
  const ran: string[] = [];

  for (const file of files) {
    const sql = readFileSync(join(dir, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const prior = applied.get(file);
    if (prior) {
      if (prior !== checksum) throw new Error(`Migration ${file} was modified after being applied`);
      continue;
    }
    await db.exec(
      `BEGIN;\n${sql}\nINSERT INTO schema_migrations (name, checksum) VALUES ('${file}', '${checksum}');\nCOMMIT;`,
    );
    ran.push(file);
  }
  return ran;
}
