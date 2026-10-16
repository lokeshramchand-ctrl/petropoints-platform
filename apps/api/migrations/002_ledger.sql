-- 002: double-entry points ledger
-- Every movement of points is a transaction made of >= 2 entries whose deltas sum to zero.
-- Customer wallet accounts can never go negative. Rows are immutable once written.

CREATE TABLE accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN (
    'CUSTOMER_WALLET', 'PROGRAM_ISSUANCE', 'PROGRAM_REDEMPTION', 'PROGRAM_ADJUSTMENT', 'PROGRAM_EXPIRY')),
  customer_id uuid REFERENCES customers (id),
  balance     bigint NOT NULL DEFAULT 0,
  version     bigint NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounts_wallet_owner_chk CHECK ((kind = 'CUSTOMER_WALLET') = (customer_id IS NOT NULL)),
  CONSTRAINT accounts_wallet_nonneg_chk CHECK (kind <> 'CUSTOMER_WALLET' OR balance >= 0)
);
CREATE UNIQUE INDEX accounts_wallet_uq ON accounts (customer_id) WHERE kind = 'CUSTOMER_WALLET';
CREATE UNIQUE INDEX accounts_system_uq ON accounts (kind) WHERE kind <> 'CUSTOMER_WALLET';

INSERT INTO accounts (kind) VALUES
  ('PROGRAM_ISSUANCE'), ('PROGRAM_REDEMPTION'), ('PROGRAM_ADJUSTMENT'), ('PROGRAM_EXPIRY');

CREATE TABLE outlet_slip_counters (
  outlet_id uuid PRIMARY KEY REFERENCES outlets (id),
  last_seq  bigint NOT NULL DEFAULT 0
);

CREATE TABLE transactions (
  id               uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  type             text NOT NULL CHECK (type IN ('EARN', 'REDEEM', 'REVERSAL', 'ADJUSTMENT', 'EXPIRY')),
  customer_id      uuid NOT NULL REFERENCES customers (id),
  merchant_id      uuid REFERENCES merchants (id),
  outlet_id        uuid REFERENCES outlets (id),
  device_id        uuid REFERENCES devices (id),
  actor_user_id    uuid NOT NULL REFERENCES users (id),
  idempotency_key  text NOT NULL,
  request_hash     text NOT NULL,
  points           bigint NOT NULL CHECK (points <> 0),          -- signed effect on the customer wallet
  amount_paise     bigint CHECK (amount_paise IS NULL OR amount_paise > 0),
  fuel_type        text,
  quantity_ml      bigint,
  reversal_of      uuid UNIQUE REFERENCES transactions (id),     -- a transaction can be reversed once
  reason           text,
  slip_number      text UNIQUE,
  balance_after    bigint NOT NULL CHECK (balance_after >= 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor_user_id, idempotency_key),
  CONSTRAINT txn_sign_chk CHECK (
    (type = 'EARN' AND points > 0) OR (type = 'REDEEM' AND points < 0) OR type IN ('REVERSAL', 'ADJUSTMENT', 'EXPIRY')),
  CONSTRAINT txn_reversal_chk CHECK ((type = 'REVERSAL') = (reversal_of IS NOT NULL))
);
CREATE INDEX transactions_customer_idx ON transactions (customer_id, created_at DESC, id DESC);
CREATE INDEX transactions_outlet_idx ON transactions (outlet_id, created_at DESC, id DESC) WHERE outlet_id IS NOT NULL;
CREATE INDEX transactions_merchant_idx ON transactions (merchant_id, created_at DESC) WHERE merchant_id IS NOT NULL;

CREATE TABLE ledger_entries (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES transactions (id),
  account_id     uuid NOT NULL REFERENCES accounts (id),
  delta          bigint NOT NULL CHECK (delta <> 0),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_txn_idx ON ledger_entries (transaction_id);
CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_id, id DESC);

-- Immutability: the ledger is append-only.
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% not allowed)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'integrity_constraint_violation';
END $$;

CREATE TRIGGER transactions_immutable BEFORE UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_entries_immutable BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Double-entry invariant, checked at COMMIT: entries of a transaction must sum to zero.
CREATE FUNCTION assert_transaction_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE total bigint; n int;
BEGIN
  SELECT COALESCE(SUM(delta), 0), COUNT(*) INTO total, n FROM ledger_entries WHERE transaction_id = NEW.transaction_id;
  IF total <> 0 OR n < 2 THEN
    RAISE EXCEPTION 'ledger transaction % is unbalanced (sum=%, entries=%)', NEW.transaction_id, total, n
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_transaction_balanced();
