-- 0029: serialize named -> peer conversion against invitations and membership.
-- The repository repeats these predicates in its conditional UPDATE so callers
-- receive useful errors; these guards protect writes that race that UPDATE.
-- 0028 is already applied in upgraded databases. Replace its cardinality
-- triggers so soft-deleted people are not counted by one path but ignored by
-- another.
-- A deployment can create a generic invitation after 0028 has classified a
-- group as a peer but before this migration installs the write guard. Close
-- that upgrade-window state using the same terminal timestamp as 0028.
UPDATE group_invitations
SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE target_person_id IS NULL
  AND revoked_at IS NULL AND accepted_at IS NULL AND rejected_at IS NULL
  AND group_id IN (SELECT id FROM groups WHERE kind='peer');

DROP TRIGGER IF EXISTS peer_group_member_limit_insert;
DROP TRIGGER IF EXISTS peer_group_member_limit_update;
DROP TRIGGER IF EXISTS peer_group_kind_limit;

CREATE TRIGGER IF NOT EXISTS peer_group_member_limit_insert
BEFORE INSERT ON group_members
WHEN NEW.deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM groups WHERE id=NEW.group_id AND kind='peer' AND deleted_at IS NULL)
  AND (SELECT COUNT(*) FROM group_members active_member JOIN people active_person ON active_person.id=active_member.person_id
    WHERE active_member.group_id=NEW.group_id AND active_member.deleted_at IS NULL AND active_person.deleted_at IS NULL)>=2
BEGIN
  SELECT RAISE(ABORT,'PEER_LIMIT');
END;

CREATE TRIGGER IF NOT EXISTS peer_group_member_limit_update
BEFORE UPDATE OF group_id,person_id,deleted_at ON group_members
WHEN NEW.deleted_at IS NULL
  AND (OLD.deleted_at IS NOT NULL OR OLD.group_id!=NEW.group_id OR OLD.person_id!=NEW.person_id)
  AND EXISTS (SELECT 1 FROM groups WHERE id=NEW.group_id AND kind='peer' AND deleted_at IS NULL)
  AND (SELECT COUNT(*) FROM group_members active_member JOIN people active_person ON active_person.id=active_member.person_id
    WHERE active_member.group_id=NEW.group_id AND active_member.deleted_at IS NULL AND active_member.person_id!=OLD.person_id AND active_person.deleted_at IS NULL)>=2
BEGIN
  SELECT RAISE(ABORT,'PEER_LIMIT');
END;

CREATE TRIGGER IF NOT EXISTS peer_group_kind_limit
BEFORE UPDATE OF kind ON groups
WHEN NEW.kind='peer' AND OLD.kind!='peer'
  AND (SELECT COUNT(*) FROM group_members active_member JOIN people active_person ON active_person.id=active_member.person_id
    WHERE active_member.group_id=NEW.id AND active_member.deleted_at IS NULL AND active_person.deleted_at IS NULL)!=2
BEGIN
  SELECT RAISE(ABORT,'PEER_LIMIT');
END;

CREATE TRIGGER IF NOT EXISTS peer_group_person_restore_guard
BEFORE UPDATE OF deleted_at ON people
WHEN OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM group_members restoring_member
    JOIN groups peer_group ON peer_group.id=restoring_member.group_id
    WHERE restoring_member.person_id=NEW.id AND restoring_member.deleted_at IS NULL
      AND peer_group.kind='peer' AND peer_group.deleted_at IS NULL
      AND (SELECT COUNT(*) FROM group_members other_member
        JOIN people other_person ON other_person.id=other_member.person_id
        WHERE other_member.group_id=restoring_member.group_id
          AND other_member.person_id!=NEW.id AND other_member.deleted_at IS NULL
          AND other_person.deleted_at IS NULL)>=2)
BEGIN
  SELECT RAISE(ABORT,'PEER_LIMIT');
END;

CREATE TRIGGER IF NOT EXISTS peer_group_kind_eligibility
BEFORE UPDATE OF kind ON groups
WHEN NEW.kind='peer' AND OLD.kind!='peer'
  AND (
    (SELECT COUNT(*) FROM group_members active_member JOIN people active_person ON active_person.id=active_member.person_id
      WHERE active_member.group_id=NEW.id AND active_member.deleted_at IS NULL AND active_person.deleted_at IS NULL)!=2
    OR EXISTS (SELECT 1 FROM group_invitations pending_invitation
      WHERE pending_invitation.group_id=NEW.id AND pending_invitation.target_person_id IS NULL
        AND pending_invitation.revoked_at IS NULL AND pending_invitation.accepted_at IS NULL
        AND pending_invitation.rejected_at IS NULL AND pending_invitation.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )
BEGIN
  SELECT RAISE(ABORT,'PEER_LIMIT');
END;

CREATE TRIGGER IF NOT EXISTS peer_group_generic_invitation_guard
BEFORE INSERT ON group_invitations
WHEN NEW.target_person_id IS NULL
  AND NEW.revoked_at IS NULL AND NEW.accepted_at IS NULL AND NEW.rejected_at IS NULL
  AND NEW.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
  AND EXISTS (SELECT 1 FROM groups WHERE id=NEW.group_id AND kind='peer' AND deleted_at IS NULL)
BEGIN
  SELECT RAISE(ABORT,'PEER_LIMIT');
END;

CREATE TRIGGER IF NOT EXISTS peer_group_generic_invitation_update_guard
BEFORE UPDATE OF group_id,target_person_id,revoked_at,accepted_at,rejected_at,expires_at ON group_invitations
WHEN NEW.target_person_id IS NULL
  AND NEW.revoked_at IS NULL AND NEW.accepted_at IS NULL AND NEW.rejected_at IS NULL
  AND NEW.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
  AND EXISTS (SELECT 1 FROM groups WHERE id=NEW.group_id AND kind='peer' AND deleted_at IS NULL)
BEGIN
  SELECT RAISE(ABORT,'PEER_LIMIT');
END;

CREATE TRIGGER IF NOT EXISTS peer_group_targeted_invitation_update_guard
BEFORE UPDATE OF group_id,target_person_id,revoked_at,accepted_at,rejected_at,expires_at ON group_invitations
WHEN NEW.target_person_id IS NOT NULL
  AND NEW.revoked_at IS NULL AND NEW.accepted_at IS NULL AND NEW.rejected_at IS NULL
  AND NEW.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
  AND EXISTS (SELECT 1 FROM groups WHERE id=NEW.group_id AND kind='peer' AND deleted_at IS NULL)
  AND NOT EXISTS (SELECT 1 FROM group_members active_member
    JOIN people active_person ON active_person.id=active_member.person_id
    WHERE active_member.group_id=NEW.group_id AND active_member.person_id=NEW.target_person_id
      AND active_member.deleted_at IS NULL AND active_person.deleted_at IS NULL)
BEGIN
  SELECT RAISE(ABORT,'PEER_LIMIT');
END;

CREATE TRIGGER IF NOT EXISTS targeted_invitation_account_update_guard
BEFORE UPDATE OF group_id,target_person_id,email_normalized,revoked_at,accepted_at,rejected_at,expires_at ON group_invitations
WHEN NEW.target_person_id IS NOT NULL
  AND NEW.revoked_at IS NULL AND NEW.accepted_at IS NULL AND NEW.rejected_at IS NULL
  AND NEW.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
  AND EXISTS (
    SELECT 1 FROM people target_person
    LEFT JOIN users target_user ON target_user.id=target_person.user_id AND target_user.deleted_at IS NULL
    WHERE target_person.id=NEW.target_person_id
      AND target_person.user_id IS NOT NULL
      AND (target_user.id IS NULL OR lower(target_user.email)!=lower(NEW.email_normalized))
  )
BEGIN
  SELECT RAISE(ABORT,'INVITATION_TARGET_ACCOUNT_MISMATCH');
END;
