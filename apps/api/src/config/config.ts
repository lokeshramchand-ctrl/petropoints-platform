import { z } from 'zod';

const secret = z.string().min(32, 'must be at least 32 characters');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().url(),
  DATABASE_REPLICA_URL: z
    .string()
    .url()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  REDIS_URL: z
    .string()
    .url()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  KAFKA_BROKERS: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()) : [])),

  JWT_ACCESS_SECRET: secret,
  JWT_REFRESH_SECRET: secret,
  SLIP_HMAC_SECRET: secret,
  PII_HASH_PEPPER: secret,
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(3600)
    .default(60 * 60 * 24 * 30),

  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default('PetroPoints <no-reply@petropoints.local>'),

  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  SWAGGER_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z
    .string()
    .url()
    .optional()
    .or(z.literal('').transform(() => undefined)),
});

export type AppConfig = z.infer<typeof schema>;

const PLACEHOLDER = /(change-?me|dev-|example|secret-secret)/i;

/**
 * Fails fast at boot. In production, placeholder secrets and missing infrastructure are fatal,
 * so a misconfigured deploy never starts serving traffic.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const cfg = parsed.data;

  if (cfg.NODE_ENV === 'production') {
    const problems: string[] = [];
    for (const k of [
      'JWT_ACCESS_SECRET',
      'JWT_REFRESH_SECRET',
      'SLIP_HMAC_SECRET',
      'PII_HASH_PEPPER',
    ] as const) {
      if (PLACEHOLDER.test(cfg[k])) problems.push(`${k} looks like a development placeholder`);
    }
    if (cfg.JWT_ACCESS_SECRET === cfg.JWT_REFRESH_SECRET) {
      problems.push('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ');
    }
    if (!cfg.REDIS_URL) problems.push('REDIS_URL is required in production');
    if (cfg.KAFKA_BROKERS.length === 0) problems.push('KAFKA_BROKERS is required in production');
    if (cfg.SWAGGER_ENABLED) problems.push('SWAGGER_ENABLED must be false in production');
    if (cfg.CORS_ORIGINS.includes('*')) problems.push('CORS_ORIGINS must not contain *');
    if (problems.length)
      throw new Error(`Unsafe production configuration:\n  - ${problems.join('\n  - ')}`);
  }
  return cfg;
}
