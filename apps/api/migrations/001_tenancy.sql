-- 001: identity & tenancy
CREATE TABLE merchants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  gstin       text UNIQUE,
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outlets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants (id),
  code        text NOT NULL CHECK (code ~ '^[A-Z0-9]{2,8}$'),
  name        text NOT NULL,
  city        text,
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code)
);
CREATE INDEX outlets_merchant_idx ON outlets (merchant_id);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  mobile        text,
  name          text NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (role IN (
    'SUPER_ADMIN','PLATFORM_ADMIN','SUPPORT_AGENT','MERCHANT_OWNER','MERCHANT_MANAGER','CASHIER','CUSTOMER')),
  merchant_id   uuid REFERENCES merchants (id),
  outlet_id     uuid REFERENCES outlets (id),
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  failed_logins int  NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- tenancy invariants: merchant staff need a merchant, cashiers need an outlet, platform/customers have neither
  CONSTRAINT users_tenancy_chk CHECK (
    (role IN ('MERCHANT_OWNER','MERCHANT_MANAGER') AND merchant_id IS NOT NULL)
    OR (role = 'CASHIER' AND merchant_id IS NOT NULL AND outlet_id IS NOT NULL)
    OR (role IN ('SUPER_ADMIN','PLATFORM_ADMIN','SUPPORT_AGENT','CUSTOMER') AND merchant_id IS NULL AND outlet_id IS NULL)
  )
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));
CREATE UNIQUE INDEX users_mobile_uq ON users (mobile) WHERE mobile IS NOT NULL;
CREATE INDEX users_merchant_idx ON users (merchant_id) WHERE merchant_id IS NOT NULL;

CREATE TABLE customers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL UNIQUE REFERENCES users (id),
  mobile        text NOT NULL UNIQUE,
  name          text NOT NULL,
  city          text,
  -- PII minimisation: never store the raw national ID, only a peppered hash + last 4
  national_id_hash text,
  national_id_last4 char(4),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE devices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outlet_id   uuid NOT NULL REFERENCES outlets (id),
  serial      text NOT NULL UNIQUE,
  label       text,
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED')),
  last_seen_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX devices_outlet_idx ON devices (outlet_id);

CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  family_id   uuid NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);
