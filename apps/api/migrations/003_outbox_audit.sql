-- 003: transactional outbox + audit log

CREATE TABLE outbox_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_id  uuid NOT NULL,
  event_type    text NOT NULL,
  topic         text NOT NULL,
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz,
  attempts      int NOT NULL DEFAULT 0
);
-- relay scans only the unpublished tail
CREATE INDEX outbox_unpublished_idx ON outbox_events (created_at) WHERE published_at IS NULL;

CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id    uuid,
  actor_role  text,
  action      text NOT NULL,
  target_type text,
  target_id   text,
  ip          inet,
  request_id  text,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_id, created_at DESC);
CREATE INDEX audit_log_target_idx ON audit_log (target_type, target_id);

CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
