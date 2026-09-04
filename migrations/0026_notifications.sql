-- Push subscriptions are account-bound, but the endpoint and client keys are
-- encrypted by the Worker. endpoint_hash is only a keyed lookup value.
PRAGMA foreign_keys = ON;

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  endpoint_hash TEXT NOT NULL CHECK(length(endpoint_hash) = 64),
  subscription_ciphertext TEXT NOT NULL,
  expiration_time INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX idx_push_subscriptions_user ON push_subscriptions(user_id, revoked_at);

CREATE TABLE notification_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  money_changes INTEGER NOT NULL DEFAULT 1 CHECK(money_changes IN (0,1)),
  scheduled_events INTEGER NOT NULL DEFAULT 1 CHECK(scheduled_events IN (0,1)),
  detail_level TEXT NOT NULL DEFAULT 'generic' CHECK(detail_level IN ('generic','detailed')),
  updated_at TEXT NOT NULL
);

CREATE TABLE notification_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'expense_created','expense_updated','expense_deleted','expense_restored',
    'settlement_created','settlement_updated','settlement_deleted','settlement_restored',
    'scheduled_expense_generated','scheduled_expense_blocked'
  )),
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
  entity_type TEXT NOT NULL CHECK(entity_type IN ('expense','settlement','scheduled_expense')),
  entity_id TEXT NOT NULL,
  entity_version INTEGER NOT NULL CHECK(entity_version > 0),
  -- Deliberately small, notification-safe revision data. Delivery never
  -- resolves mutable ledger rows after this mutation has committed.
  description_snapshot TEXT,
  amount_minor_snapshot INTEGER,
  currency_snapshot TEXT,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  occurred_at TEXT NOT NULL,
  queued_at TEXT,
  completed_at TEXT
);
CREATE INDEX idx_notification_events_outbox ON notification_events(completed_at, queued_at, occurred_at, id);
CREATE INDEX idx_notification_events_group ON notification_events(group_id, occurred_at, id);
CREATE INDEX idx_notification_events_retention ON notification_events(completed_at, id) WHERE completed_at IS NOT NULL;

CREATE TABLE notification_deliveries (
  event_id TEXT NOT NULL REFERENCES notification_events(id) ON DELETE RESTRICT,
  subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','claimed','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  sent_at TEXT,
  claim_owner TEXT,
  claim_until TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(event_id, subscription_id)
);
CREATE INDEX idx_notification_deliveries_due ON notification_deliveries(status, next_attempt_at, event_id);
CREATE INDEX idx_notification_deliveries_claim ON notification_deliveries(status, claim_until, event_id);
CREATE INDEX idx_notification_deliveries_retention ON notification_deliveries(status, updated_at, event_id, subscription_id);

-- Soft-deleted accounts must lose all device credentials and notification
-- preferences immediately. Financial/audit rows continue to retain the user
-- FK anchor, while event actor references are nullable and anonymizable.
CREATE TRIGGER notification_revoke_on_user_deletion
AFTER UPDATE OF deleted_at ON users
WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
BEGIN
  UPDATE push_subscriptions
    SET revoked_at=COALESCE(revoked_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP
    WHERE user_id=NEW.id AND revoked_at IS NULL;
  DELETE FROM notification_preferences WHERE user_id=NEW.id;
END;
