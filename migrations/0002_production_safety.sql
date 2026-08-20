-- Additive production-safety migration following the initial schema.
ALTER TABLE people ADD COLUMN user_id TEXT REFERENCES users(id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_people_user ON people(user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_people_email_normalized ON people(lower(email)) WHERE email IS NOT NULL;

ALTER TABLE group_members ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner', 'member'));
CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id, group_id);
-- 0001 did not persist a creator. Preserve the earliest membership as the
-- owner for pre-existing groups; all new groups set this explicitly in code.
UPDATE group_members AS gm
SET role = 'owner'
WHERE gm.person_id = (
  SELECT first_member.person_id FROM group_members first_member
  WHERE first_member.group_id = gm.group_id
  ORDER BY first_member.joined_at, first_member.person_id LIMIT 1
);

ALTER TABLE expenses ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0);
ALTER TABLE settlements ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0);

-- Claims are scoped by mutation kind, authenticated user, group, and client key.
-- The request hash makes reusing a key for a different payload explicit and safe.
CREATE TABLE idempotency_keys (
  kind TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  group_id TEXT NOT NULL REFERENCES groups(id),
  operation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(kind, user_id, group_id, operation_id)
);
CREATE INDEX idx_idempotency_entity ON idempotency_keys(entity_id);
