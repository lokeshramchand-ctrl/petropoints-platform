import { z } from 'zod';
import { ROLES } from '@petropoints/rbac';

/* ---------- primitives ---------- */

export const uuid = z.string().uuid();
/** Indian mobile, E.164 normalised: +91XXXXXXXXXX */
export const mobile = z
  .string()
  .regex(/^\+91[6-9]\d{9}$/, 'Expected +91 followed by a 10 digit mobile');
/** Money is ALWAYS integer paise. Never floats. */
export const paise = z.number().int().positive().max(100_000_000);
export const pointsAmount = z.number().int().positive().max(10_000_000);
export const idempotencyKey = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_\-:.]+$/);

export const roleSchema = z.enum(ROLES);

export const FUEL_TYPES = ['PETROL', 'DIESEL', 'POWER_PETROL', 'CNG', 'LPG', 'OTHER'] as const;
export const fuelType = z.enum(FUEL_TYPES);

/* ---------- auth ---------- */

/** trim + lowercase BEFORE validating, so " Foo@Bar.com " is accepted and normalised. */
export const email = z.string().trim().toLowerCase().email().max(254);

export const loginRequest = z.object({
  email,
  password: z.string().min(8).max(128),
});
export type LoginRequest = z.infer<typeof loginRequest>;

export const registerCustomerRequest = z.object({
  name: z.string().trim().min(2).max(100),
  email,
  mobile,
  password: z.string().min(8).max(128),
  city: z.string().trim().max(80).optional(),
});
export type RegisterCustomerRequest = z.infer<typeof registerCustomerRequest>;

export const refreshRequest = z.object({ refreshToken: z.string().min(20) });

export const tokenPair = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresInSeconds: z.number().int(),
});
export type TokenPair = z.infer<typeof tokenPair>;

/* ---------- points ---------- */

export const earnPointsRequest = z.object({
  customerMobile: mobile,
  outletId: uuid,
  amountPaise: paise,
  fuelType,
  /** litres * 1000, optional for non-fuel purchases */
  quantityMilliLitres: z.number().int().positive().max(10_000_000).optional(),
});
export type EarnPointsRequest = z.infer<typeof earnPointsRequest>;

export const redeemPointsRequest = z.object({
  customerMobile: mobile,
  outletId: uuid,
  points: pointsAmount,
});
export type RedeemPointsRequest = z.infer<typeof redeemPointsRequest>;

export const reverseRequest = z.object({ reason: z.string().trim().min(3).max(300) });

export const adjustRequest = z.object({
  customerId: uuid,
  /** signed; positive credits, negative debits */
  points: z
    .number()
    .int()
    .refine((n) => n !== 0, 'points must be non-zero'),
  reason: z.string().trim().min(3).max(300),
});

export const TXN_TYPES = ['EARN', 'REDEEM', 'REVERSAL', 'ADJUSTMENT', 'EXPIRY'] as const;
export type TxnType = (typeof TXN_TYPES)[number];

export const transactionView = z.object({
  id: uuid,
  type: z.enum(TXN_TYPES),
  points: z.number().int(),
  amountPaise: z.number().int().nullable(),
  balanceAfter: z.number().int(),
  outletId: uuid.nullable(),
  slipNumber: z.string().nullable(),
  reversalOf: uuid.nullable(),
  createdAt: z.string().datetime(),
});
export type TransactionView = z.infer<typeof transactionView>;

export const slipView = z.object({
  slipNumber: z.string(),
  transactionId: uuid,
  type: z.enum(TXN_TYPES),
  merchantName: z.string(),
  outletName: z.string(),
  customerName: z.string(),
  customerMobileMasked: z.string(),
  points: z.number().int(),
  balanceAfter: z.number().int(),
  amountPaise: z.number().int().nullable(),
  createdAt: z.string().datetime(),
  /** HMAC signature so a printed slip can be verified later */
  signature: z.string(),
});
export type SlipView = z.infer<typeof slipView>;

/* ---------- pagination ---------- */

export const pageQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type PageQuery = z.infer<typeof pageQuery>;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/* ---------- error envelope ---------- */

export interface ApiError {
  error: {
    code: string;
    message: string;
    requestId?: string;
    details?: unknown;
  };
}

/* ---------- domain events (versioned, backward compatible only) ---------- */

const eventBase = z.object({
  eventId: uuid,
  occurredAt: z.string().datetime(),
  schemaVersion: z.literal(1),
});

export const pointsEarnedV1 = eventBase.extend({
  type: z.literal('points.earned.v1'),
  transactionId: uuid,
  customerId: uuid,
  merchantId: uuid,
  outletId: uuid,
  points: z.number().int().positive(),
  amountPaise: z.number().int().positive(),
  fuelType,
});

export const pointsRedeemedV1 = eventBase.extend({
  type: z.literal('points.redeemed.v1'),
  transactionId: uuid,
  customerId: uuid,
  merchantId: uuid,
  outletId: uuid,
  points: z.number().int().positive(),
});

export const pointsReversedV1 = eventBase.extend({
  type: z.literal('points.reversed.v1'),
  transactionId: uuid,
  originalTransactionId: uuid,
  customerId: uuid,
  points: z.number().int(),
  reason: z.string(),
});

export const domainEvent = z.discriminatedUnion('type', [
  pointsEarnedV1,
  pointsRedeemedV1,
  pointsReversedV1,
]);
export type DomainEvent = z.infer<typeof domainEvent>;

export const TOPICS = {
  'points.earned.v1': 'petropoints.points.earned.v1',
  'points.redeemed.v1': 'petropoints.points.redeemed.v1',
  'points.reversed.v1': 'petropoints.points.reversed.v1',
} as const;

/* ---------- earn rule ---------- */

/**
 * Default program rule: 1 point per ₹100 spent (floor). Pure + shared so web/mobile can preview
 * the same number the server will award. Server is authoritative.
 */
export const DEFAULT_PAISE_PER_POINT = 10_000;
export function pointsForSpend(
  amountPaise: number,
  paisePerPoint = DEFAULT_PAISE_PER_POINT,
): number {
  if (!Number.isInteger(amountPaise) || amountPaise < 0)
    throw new RangeError('amountPaise must be a non-negative integer');
  return Math.floor(amountPaise / paisePerPoint);
}

export function maskMobile(m: string): string {
  return m.length < 6 ? '****' : `${m.slice(0, 3)}${'*'.repeat(m.length - 6)}${m.slice(-3)}`;
}
