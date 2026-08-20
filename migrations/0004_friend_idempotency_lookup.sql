-- Friend creation has no pre-existing group scope. Keep its claim in the
-- existing idempotency table and add the lookup path used before the group
-- exists in the client request.
CREATE UNIQUE INDEX IF NOT EXISTS idx_idempotency_friend_operation
  ON idempotency_keys(user_id, operation_id)
  WHERE kind = 'friend.create';

CREATE INDEX IF NOT EXISTS idx_idempotency_operation ON idempotency_keys(kind, user_id, operation_id);
