import { createTransport } from 'nodemailer';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/** SMTP mailer. In development SMTP_HOST points at Mailpit, so every email is caught locally. */
export class SmtpMailer implements Mailer {
  private readonly transport;
  constructor(
    cfg: { host: string; port: number; user?: string; pass?: string; from: string },
    private readonly from = cfg.from,
  ) {
    this.transport = createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.port === 465,
      ...(cfg.user && { auth: { user: cfg.user, pass: cfg.pass } }),
    });
  }

  async send(mail: Mail) {
    await this.transport.sendMail({ from: this.from, ...mail });
  }
}

/** Collects mail in memory for tests. */
export class MemoryMailer implements Mailer {
  readonly sent: Mail[] = [];
  async send(mail: Mail) {
    this.sent.push(mail);
  }
}

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

export const templates = {
  welcome(name: string): Omit<Mail, 'to'> {
    return {
      subject: 'Welcome to PetroPoints',
      text: `Hi ${name},\n\nYour PetroPoints account is ready. Show your registered mobile number at any partner petrol bunk to earn points on every fill-up.\n\n— PetroPoints`,
      html: `<p>Hi ${escapeHtml(name)},</p><p>Your PetroPoints account is ready. Show your registered mobile number at any partner petrol bunk to earn points on every fill-up.</p><p>— PetroPoints</p>`,
    };
  },
  pointsEarned(name: string, points: number, rupees: number): Omit<Mail, 'to'> {
    return {
      subject: `You earned ${points} PetroPoints`,
      text: `Hi ${name},\n\nYou earned ${points} points on a purchase of ₹${rupees.toFixed(2)}.\n\n— PetroPoints`,
      html: `<p>Hi ${escapeHtml(name)},</p><p>You earned <b>${points}</b> points on a purchase of ₹${rupees.toFixed(2)}.</p>`,
    };
  },
  pointsRedeemed(name: string, points: number): Omit<Mail, 'to'> {
    return {
      subject: `You redeemed ${points} PetroPoints`,
      text: `Hi ${name},\n\nYou redeemed ${points} points.\n\n— PetroPoints`,
      html: `<p>Hi ${escapeHtml(name)},</p><p>You redeemed <b>${points}</b> points.</p>`,
    };
  },
};
