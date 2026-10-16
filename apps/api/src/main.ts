import { createApp } from './bootstrap';
import { loadConfig } from './config/config';
import { PgDb } from './db/pg-db';

async function main() {
  const config = loadConfig();
  const db = new PgDb({ connectionString: config.DATABASE_URL });
  const app = await createApp(config, db);
  await app.listen(config.PORT, '0.0.0.0');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
