import { PgDb } from './pg-db';
import { migrate } from './migrate';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const db = new PgDb({ connectionString: url, max: 1 });
  try {
    const ran = await migrate(db);
    console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'Database is up to date');
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
