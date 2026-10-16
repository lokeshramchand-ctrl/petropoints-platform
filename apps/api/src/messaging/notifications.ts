import { domainEvent } from '@petropoints/contracts';
import type { Db } from '../db/db';
import { templates, type Mailer } from '../mail/mail.service';

/**
 * Notification consumer logic. De-duplicates on eventId (the bus is at-least-once), so a redelivered
 * event never produces a second email. The dedupe record is written AFTER a successful send: a crash
 * in between re-sends once rather than dropping a notification.
 */
export class NotificationHandler {
  constructor(
    private readonly db: Db,
    private readonly mailer: Mailer,
  ) {}

  async handle(raw: unknown): Promise<'sent' | 'duplicate' | 'ignored'> {
    const parsed = domainEvent.safeParse(raw);
    // Unknown/newer event versions are skipped, not fatal: producers evolve ahead of consumers.
    if (!parsed.success) return 'ignored';
    const e = parsed.data;

    const seen = await this.db.query(
      'SELECT 1 FROM processed_events WHERE consumer = $1 AND event_id = $2',
      ['notifications', e.eventId],
    );
    if (seen.rows.length > 0) return 'duplicate';

    let result: 'sent' | 'ignored' = 'ignored';
    switch (e.type) {
      case 'user.registered.v1':
        await this.mailer.send({ to: e.email, ...templates.welcome(e.name) });
        result = 'sent';
        break;
      case 'points.earned.v1': {
        const c = await this.customer(e.customerId);
        if (c) {
          await this.mailer.send({
            to: c.email,
            ...templates.pointsEarned(c.name, e.points, e.amountPaise / 100),
          });
          result = 'sent';
        }
        break;
      }
      case 'points.redeemed.v1': {
        const c = await this.customer(e.customerId);
        if (c) {
          await this.mailer.send({ to: c.email, ...templates.pointsRedeemed(c.name, e.points) });
          result = 'sent';
        }
        break;
      }
      case 'points.reversed.v1':
        break;
    }

    await this.db.query(
      'INSERT INTO processed_events (consumer, event_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      ['notifications', e.eventId],
    );
    return result;
  }

  private async customer(customerId: string) {
    return (
      await this.db.query<{ email: string; name: string }>(
        'SELECT u.email, c.name FROM customers c JOIN users u ON u.id = c.user_id WHERE c.id = $1',
        [customerId],
      )
    ).rows[0];
  }
}
