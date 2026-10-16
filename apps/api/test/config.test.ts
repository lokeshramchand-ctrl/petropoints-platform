import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/config';

const good = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
  SLIP_HMAC_SECRET: 'c'.repeat(40),
  PII_HASH_PEPPER: 'd'.repeat(40),
};

describe('config', () => {
  it('applies safe defaults in development', () => {
    const c = loadConfig({ ...good, NODE_ENV: 'development' });
    expect(c.PORT).toBe(3000);
    expect(c.SWAGGER_ENABLED).toBe(false);
    expect(c.KAFKA_BROKERS).toEqual([]);
  });

  it('fails fast on missing or short secrets', () => {
    expect(() => loadConfig({ ...good, JWT_ACCESS_SECRET: 'short' })).toThrow(/JWT_ACCESS_SECRET/);
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('refuses unsafe production setups', () => {
    const prod = {
      ...good,
      NODE_ENV: 'production',
      REDIS_URL: 'redis://r:6379',
      KAFKA_BROKERS: 'k:9092',
    };
    expect(() => loadConfig(prod)).not.toThrow();
    expect(() =>
      loadConfig({ ...prod, JWT_ACCESS_SECRET: 'dev-access-secret-change-me-dev-access' }),
    ).toThrow(/placeholder/);
    expect(() => loadConfig({ ...prod, JWT_REFRESH_SECRET: good.JWT_ACCESS_SECRET })).toThrow(
      /must differ/,
    );
    expect(() => loadConfig({ ...prod, REDIS_URL: '' })).toThrow(/REDIS_URL/);
    expect(() => loadConfig({ ...prod, SWAGGER_ENABLED: 'true' })).toThrow(/SWAGGER/);
    expect(() => loadConfig({ ...prod, CORS_ORIGINS: '*' })).toThrow(/CORS/);
  });
});
