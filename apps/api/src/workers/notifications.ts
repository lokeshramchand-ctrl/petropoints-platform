import { TOPICS } from '@petropoints/contracts';
import { loadConfig } from '../config/config';
import { PgDb } from '../db/pg-db';
import { SmtpMailer } from '../mail/mail.service';
import { createKafka, runConsumer } from '../messaging/kafka';
import { NotificationHandler } from '../messaging/notifications';

async function main() {
  const config = loadConfig();
  const db = new PgDb({ connectionString: config.DATABASE_URL, max: 4 });
  const mailer = new SmtpMailer({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    user: config.SMTP_USER,
    pass: config.SMTP_PASS,
    from: config.MAIL_FROM,
  });
  const handler = new NotificationHandler(db, mailer);
  const consumer = await runConsumer(
    createKafka(config.KAFKA_BROKERS, 'petropoints-notifications'),
    {
      groupId: 'petropoints-notifications',
      topics: [
        TOPICS['user.registered.v1'],
        TOPICS['points.earned.v1'],
        TOPICS['points.redeemed.v1'],
      ],
      handle: async (payload) => void (await handler.handle(payload)),
    },
  );
  console.log('notifications consumer started');
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(
      sig,
      () =>
        void consumer
          .disconnect()
          .then(() => db.close())
          .then(() => process.exit(0)),
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
