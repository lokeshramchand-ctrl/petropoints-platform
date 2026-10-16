-- 004: consumer-side idempotency. Each consumer records the event ids it has already handled.
CREATE TABLE processed_events (
  consumer     text NOT NULL,
  event_id     uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);
