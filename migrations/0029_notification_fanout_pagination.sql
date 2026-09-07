-- Notification fan-out is resumable. The cursor follows the same stable
-- composite key as the subscription index, so SQLite can stop the ordered
-- page at the cursor instead of scanning/sorting a user-leading index.
ALTER TABLE notification_events ADD COLUMN fanout_user_id TEXT;
ALTER TABLE notification_events ADD COLUMN fanout_subscription_id TEXT;
ALTER TABLE notification_events ADD COLUMN fanout_complete INTEGER NOT NULL DEFAULT 0 CHECK(fanout_complete IN (0,1));

CREATE TABLE notification_completion_cursor (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  occurred_at TEXT,
  event_id TEXT
);
INSERT INTO notification_completion_cursor(id,occurred_at,event_id) VALUES(1,NULL,NULL);

CREATE INDEX idx_group_members_notification_user ON group_members(group_id,user_id,deleted_at,person_id);
-- Include the eligibility columns so the ordered continuation query is
-- covered while retaining (user_id,id) as its composite seek key.
CREATE INDEX idx_push_subscriptions_notification_fanout ON push_subscriptions(user_id,id,expiration_time,revoked_at) WHERE revoked_at IS NULL;
