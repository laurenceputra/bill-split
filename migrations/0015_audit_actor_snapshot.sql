-- Keep audit actors useful after a person is renamed or removed.  The user ID
-- remains the stable authorization identity; the person ID and name are
-- snapshots and never contain contact details.
ALTER TABLE audit_events ADD COLUMN actor_person_id TEXT REFERENCES people(id);
ALTER TABLE audit_events ADD COLUMN actor_name TEXT;

UPDATE audit_events
SET actor_person_id = (
      SELECT p.id FROM people p
      WHERE p.user_id = audit_events.actor_id
        AND p.deleted_at IS NULL
      LIMIT 1
    ),
    actor_name = COALESCE((
      SELECT p.name FROM people p
      WHERE p.user_id = audit_events.actor_id
        AND p.deleted_at IS NULL
      LIMIT 1
    ), 'Unknown user')
WHERE actor_name IS NULL;

CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_events(actor_id, occurred_at DESC);
