-- 0025: support the private split-default suggestion lookup.
CREATE INDEX IF NOT EXISTS idx_expenses_suggestion_lookup
  ON expenses(group_id,created_by,created_at DESC,id DESC)
  WHERE deleted_at IS NULL;
