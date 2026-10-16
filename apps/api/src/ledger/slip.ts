import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SlipSignable {
  slipNumber: string;
  transactionId: string;
  points: number;
  createdAt: string;
}

/** HMAC over the immutable facts of a slip, so a printed receipt can be verified later. */
export function signSlip(secret: string, s: SlipSignable): string {
  return createHmac('sha256', secret)
    .update(`${s.slipNumber}|${s.transactionId}|${s.points}|${s.createdAt}`)
    .digest('base64url');
}

export function verifySlip(secret: string, s: SlipSignable, signature: string): boolean {
  const expected = Buffer.from(signSlip(secret, s));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
