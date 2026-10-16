import { hashPassword } from '../auth/password';
import { PgDb } from './pg-db';

/**
 * Creates the first SUPER_ADMIN. The password is read from the environment (never a default) and
 * the script refuses to run if any super admin already exists.
 */
async function main() {
  const { DATABASE_URL, SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD } = process.env;
  if (!DATABASE_URL || !SEED_ADMIN_EMAIL || !SEED_ADMIN_PASSWORD) {
    throw new Error('DATABASE_URL, SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD are required');
  }
  if (SEED_ADMIN_PASSWORD.length < 12)
    throw new Error('SEED_ADMIN_PASSWORD must be at least 12 characters');

  const db = new PgDb({ connectionString: DATABASE_URL, max: 1 });
  try {
    const existing = await db.query(`SELECT 1 FROM users WHERE role = 'SUPER_ADMIN' LIMIT 1`);
    if (existing.rows.length > 0) {
      console.log('A super admin already exists; nothing to do.');
      return;
    }
    await db.query(
      `INSERT INTO users (email, name, password_hash, role) VALUES ($1, 'Super Admin', $2, 'SUPER_ADMIN')`,
      [SEED_ADMIN_EMAIL.toLowerCase(), await hashPassword(SEED_ADMIN_PASSWORD)],
    );
    console.log(`Created super admin ${SEED_ADMIN_EMAIL}`);
  } finally {
    await db.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
