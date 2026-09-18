-- 0028: persist whether a group is a peer ledger or a named group.
-- The default keeps the migration safe for older rows; friend idempotency
-- claims are the only durable signal that a legacy group was peer-created.
ALTER TABLE groups ADD COLUMN kind TEXT NOT NULL DEFAULT 'named' CHECK(kind IN ('named','peer'));

UPDATE groups
SET kind='peer'
WHERE id IN (
  SELECT group_id FROM idempotency_keys WHERE kind='friend.create'
)
AND (
  SELECT COUNT(*) FROM group_members active_member
  WHERE active_member.group_id=groups.id AND active_member.deleted_at IS NULL
)=2;

-- Legacy peers could have generic invitations created before targeted consent
-- existed. They cannot be accepted by a peer ledger, so close them during the
-- same migration rather than leaving an incompatible pending action.
UPDATE group_invitations
SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE target_person_id IS NULL
  AND revoked_at IS NULL AND accepted_at IS NULL AND rejected_at IS NULL
  AND group_id IN (SELECT id FROM groups WHERE kind='peer');

-- These triggers are the serialization point for peer cardinality. Repository
-- prechecks improve errors, but every membership insert/reactivation must also
-- be safe against concurrent D1 requests.
CREATE TRIGGER IF NOT EXISTS peer_group_member_limit_insert
BEFORE INSERT ON group_members
WHEN NEW.deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM groups WHERE id=NEW.group_id AND kind='peer' AND deleted_at IS NULL)
  AND (SELECT COUNT(*) FROM group_members active_member JOIN people active_person ON active_person.id=active_member.person_id WHERE active_member.group_id=NEW.group_id AND active_member.deleted_at IS NULL AND active_person.deleted_at IS NULL)>=2
BEGIN
  SELECT RAISE(ABORT,'PEER_LIMIT');
END;

CREATE TRIGGER IF NOT EXISTS peer_group_member_limit_update
BEFORE UPDATE OF group_id,person_id,deleted_at ON group_members
WHEN NEW.deleted_at IS NULL
  AND (OLD.deleted_at IS NOT NULL OR OLD.group_id!=NEW.group_id OR OLD.person_id!=NEW.person_id)
  AND EXISTS (SELECT 1 FROM groups WHERE id=NEW.group_id AND kind='peer' AND deleted_at IS NULL)
  AND (SELECT COUNT(*) FROM group_members active_member JOIN people active_person ON active_person.id=active_member.person_id WHERE active_member.group_id=NEW.group_id AND active_member.deleted_at IS NULL AND active_member.person_id!=OLD.person_id AND active_person.deleted_at IS NULL)>=2
BEGIN
  SELECT RAISE(ABORT,'PEER_LIMIT');
END;

CREATE TRIGGER IF NOT EXISTS peer_group_kind_limit
BEFORE UPDATE OF kind ON groups
  WHEN NEW.kind='peer' AND OLD.kind!='peer'
  AND (SELECT COUNT(*) FROM group_members active_member JOIN people active_person ON active_person.id=active_member.person_id WHERE active_member.group_id=NEW.id AND active_member.deleted_at IS NULL AND active_person.deleted_at IS NULL)!=2
BEGIN
  SELECT RAISE(ABORT,'PEER_LIMIT');
END;

CREATE TRIGGER IF NOT EXISTS targeted_invitation_account_guard
BEFORE INSERT ON group_invitations
WHEN NEW.target_person_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM people target_person
    LEFT JOIN users target_user ON target_user.id=target_person.user_id AND target_user.deleted_at IS NULL
    WHERE target_person.id=NEW.target_person_id
      AND (target_person.user_id IS NOT NULL AND (target_user.id IS NULL OR lower(target_user.email)!=lower(NEW.email_normalized)))
  )
BEGIN
  SELECT RAISE(ABORT,'INVITATION_TARGET_ACCOUNT_MISMATCH');
END;

CREATE INDEX IF NOT EXISTS idx_groups_kind ON groups(kind,deleted_at,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_idempotency_group_operation
  ON idempotency_keys(user_id,operation_id)
  WHERE kind='group.create';
