-- Application-managed sessions are opaque bearer credentials. Only a
-- SHA-256 digest of the random token is stored; the token itself is returned
-- once in an HttpOnly cookie and cannot be recovered from D1.
CREATE TABLE application_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash) = 64),
  created_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  idle_expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX idx_application_sessions_user ON application_sessions(user_id);
CREATE INDEX idx_application_sessions_expiry ON application_sessions(idle_expires_at);
CREATE INDEX idx_application_sessions_revoked ON application_sessions(revoked_at);

-- Account deletion updates the user and its sessions in the same D1
-- transaction. Keeping this invariant in the schema also protects future
-- deletion callers from accidentally leaving a live session behind.
CREATE TRIGGER application_sessions_revoke_on_user_deletion
AFTER UPDATE OF deleted_at ON users
WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
BEGIN
  UPDATE application_sessions SET revoked_at=NEW.deleted_at
  WHERE user_id=NEW.id AND revoked_at IS NULL;
END;
