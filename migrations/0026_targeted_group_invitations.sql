-- 0026: tie an owner-created invitation to the existing ledger participant.
-- A NULL target preserves the original generic invitation flow.
ALTER TABLE group_invitations ADD COLUMN target_person_id TEXT REFERENCES people(id);

-- Older deployments did not have a group/email uniqueness constraint. Keep the
-- oldest pending row for each normalized address, preferring a targeted row so
-- an existing participant assignment is never silently downgraded to generic.
UPDATE group_invitations AS duplicate
SET revoked_at=COALESCE(duplicate.revoked_at,duplicate.created_at)
WHERE duplicate.revoked_at IS NULL
  AND duplicate.accepted_at IS NULL
  AND duplicate.rejected_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM group_invitations AS keeper
    WHERE keeper.group_id=duplicate.group_id
      AND keeper.email_normalized=duplicate.email_normalized
      AND keeper.revoked_at IS NULL
      AND keeper.accepted_at IS NULL
      AND keeper.rejected_at IS NULL
      AND (
        (keeper.target_person_id IS NOT NULL AND duplicate.target_person_id IS NULL)
        OR (keeper.target_person_id IS NOT NULL AND duplicate.target_person_id IS NOT NULL
          AND (keeper.created_at<duplicate.created_at
            OR (keeper.created_at=duplicate.created_at AND keeper.id<duplicate.id)))
        OR (keeper.target_person_id IS NULL AND duplicate.target_person_id IS NULL
          AND (keeper.created_at<duplicate.created_at
            OR (keeper.created_at=duplicate.created_at AND keeper.id<duplicate.id)))
      )
  );

CREATE INDEX idx_group_invitations_target
  ON group_invitations(group_id,target_person_id,created_at DESC);
CREATE UNIQUE INDEX idx_group_invitations_pending_target
  ON group_invitations(group_id,target_person_id)
  WHERE target_person_id IS NOT NULL
    AND revoked_at IS NULL
    AND accepted_at IS NULL
    AND rejected_at IS NULL;
CREATE UNIQUE INDEX idx_group_invitations_pending_email
  ON group_invitations(group_id,email_normalized)
  WHERE revoked_at IS NULL
    AND accepted_at IS NULL
    AND rejected_at IS NULL;
