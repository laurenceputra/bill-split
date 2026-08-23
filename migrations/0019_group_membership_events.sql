-- Collaboration lifecycle events are kept separate from transaction audit
-- rows so the existing expense/settlement audit contract remains unchanged.
-- Names are snapshots; contact details are intentionally not stored here.
CREATE TABLE group_membership_events (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id),
  event_type TEXT NOT NULL CHECK(event_type IN ('owner_transfer','member_leave','member_remove')),
  actor_id TEXT NOT NULL REFERENCES users(id),
  actor_person_id TEXT REFERENCES people(id),
  actor_name TEXT NOT NULL,
  subject_person_id TEXT NOT NULL REFERENCES people(id),
  subject_name TEXT NOT NULL,
  previous_role TEXT NOT NULL CHECK(previous_role IN ('owner','member')),
  new_role TEXT CHECK(new_role IN ('owner','member') OR new_role IS NULL),
  occurred_at TEXT NOT NULL
);
CREATE INDEX idx_group_membership_events_group_time ON group_membership_events(group_id, occurred_at DESC, id DESC);

-- Repair legacy data before installing the invariant. Keep the earliest
-- membership, with person_id as a stable tie-breaker, and demote any other
-- active owners. This makes the migration deterministic and preserves one
-- owner semantics without relying on rowid.
UPDATE group_members
SET role='member'
WHERE role='owner' AND deleted_at IS NULL
  AND EXISTS (
    SELECT 1 FROM group_members keeper
    WHERE keeper.group_id=group_members.group_id
      AND keeper.role='owner' AND keeper.deleted_at IS NULL
      AND (keeper.joined_at<group_members.joined_at
        OR (keeper.joined_at=group_members.joined_at AND keeper.person_id<group_members.person_id))
  );

-- Some historical groups have active members but no owner. Promote the
-- earliest active membership using the same stable ordering.
UPDATE group_members
SET role='owner'
WHERE deleted_at IS NULL AND role<>'owner'
  AND NOT EXISTS (
    SELECT 1 FROM group_members owner_member
    WHERE owner_member.group_id=group_members.group_id
      AND owner_member.role='owner' AND owner_member.deleted_at IS NULL
  )
  AND person_id=(
    SELECT candidate.person_id FROM group_members candidate
    WHERE candidate.group_id=group_members.group_id AND candidate.deleted_at IS NULL
    ORDER BY candidate.joined_at ASC,candidate.person_id ASC LIMIT 1
  );

-- A healthy group has one active owner. This partial unique index makes that
-- invariant database-enforced, including concurrent writes.
CREATE UNIQUE INDEX idx_group_members_active_owner ON group_members(group_id) WHERE role='owner' AND deleted_at IS NULL;
