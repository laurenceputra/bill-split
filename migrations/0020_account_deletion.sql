-- Account deletion keeps the user row as an FK anchor for financial rows and
-- audit history. The repository replaces contact identity and clears the
-- Clerk link only after the active-owner precondition has passed.
ALTER TABLE users ADD COLUMN deleted_at TEXT;
CREATE INDEX IF NOT EXISTS idx_users_deleted_at ON users(deleted_at);
