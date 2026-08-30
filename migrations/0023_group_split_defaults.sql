-- At most one optional party split arrangement is retained for an active group.
-- The arrangement is compact JSON because it is read together with the group
-- and is not queried by individual member or value.
CREATE TABLE group_split_defaults (
  group_id TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK(method IN ('equal','percentage','shares')),
  person_ids_json TEXT NOT NULL CHECK(json_valid(person_ids_json)),
  values_json TEXT CHECK(values_json IS NULL OR json_valid(values_json)),
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_group_split_defaults_updated ON group_split_defaults(updated_at);

-- Soft-deleted groups no longer have an active owner setting. Physical group
-- purges are also protected by the foreign-key cascade above.
CREATE TRIGGER group_split_defaults_purge_on_group_delete
AFTER UPDATE OF deleted_at ON groups
WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
BEGIN
  DELETE FROM group_split_defaults WHERE group_id=NEW.id;
END;
