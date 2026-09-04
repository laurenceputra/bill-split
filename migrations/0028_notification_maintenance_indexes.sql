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
CREATE INDEX idx_notification_events_group_purge ON notification_events(group_id,id);
