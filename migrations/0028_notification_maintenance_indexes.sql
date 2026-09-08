-- Maintenance selects expired credentials by expiration and a stable ID so
-- each Cron run can delete a small deterministic batch without scanning the
-- entire push-subscription table.
CREATE INDEX idx_push_subscriptions_expiration ON push_subscriptions(expiration_time,id) WHERE expiration_time IS NOT NULL;
CREATE INDEX idx_push_subscriptions_revoked ON push_subscriptions(revoked_at,id) WHERE revoked_at IS NOT NULL;
-- Revoked rows retain their delivery history. Only one live row may claim an
-- endpoint; this lets a transfer revoke the old row before creating a new ID.
CREATE UNIQUE INDEX idx_push_subscriptions_active_endpoint ON push_subscriptions(endpoint_hash) WHERE revoked_at IS NULL;
CREATE INDEX idx_notification_deliveries_subscription ON notification_deliveries(subscription_id,event_id);
CREATE INDEX idx_notification_deliveries_event_claim ON notification_deliveries(event_id,status,claim_until);
-- Delivery fan-out and completion only inspect one event at a time. These
-- event-leading indexes keep the bounded page and constant-existence checks
-- from walking another event's recipient rows.
CREATE INDEX idx_notification_deliveries_event_status_subscription ON notification_deliveries(event_id,status,subscription_id);
CREATE INDEX idx_notification_deliveries_event_status_due ON notification_deliveries(event_id,status,next_attempt_at,subscription_id);
-- Stale incomplete-event maintenance starts with the seven-day event-age
-- range, then joins into the bounded delivery set for each selected event.
CREATE INDEX idx_notification_events_incomplete_age ON notification_events(occurred_at,id) WHERE completed_at IS NULL;
CREATE INDEX idx_group_members_notification ON group_members(group_id,deleted_at,user_id,person_id);
CREATE INDEX idx_push_subscriptions_notification_user ON push_subscriptions(user_id,revoked_at,expiration_time,id);
CREATE INDEX idx_notification_events_group_purge ON notification_events(group_id,id);
