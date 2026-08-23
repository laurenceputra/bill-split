-- Keep keyed HMAC-SHA-256 identity tombstones so a deleted Clerk identity or
-- verified email cannot be linked to a new internal user after the live
-- mapping is cleared. Raw contact identity and Clerk IDs are not retained.
ALTER TABLE users ADD COLUMN deleted_email_hash TEXT;
ALTER TABLE users ADD COLUMN deleted_clerk_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_users_deleted_email_hash ON users(deleted_email_hash);
CREATE INDEX IF NOT EXISTS idx_users_deleted_clerk_hash ON users(deleted_clerk_hash);
