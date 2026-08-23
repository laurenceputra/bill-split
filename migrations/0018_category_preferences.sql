-- Learned categories are private to the authenticated user.  The description
-- key intentionally has the same conservative normalization contract as
-- src/shared/category.ts: trim leading/trailing whitespace, then lowercase
-- ASCII letters only (SQLite lower() deliberately does not fold Unicode).
CREATE TABLE category_preferences (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  normalized_description TEXT NOT NULL
    CHECK(normalized_description = lower(trim(normalized_description)))
    CHECK(length(normalized_description) BETWEEN 1 AND 240),
  category TEXT NOT NULL
    CHECK(length(trim(category)) BETWEEN 1 AND 80),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id, normalized_description)
);

-- Seed one deterministic winner per user and normalized description. A
-- category explicitly chosen on a schedule is historical user preference;
-- cancelling the schedule must not erase that preference.
WITH candidates AS (
  SELECT e.created_by AS user_id, lower(trim(e.description)) AS normalized_description,
    trim(e.category) AS category, e.updated_at, e.id, 'expense' AS source
  FROM expenses e
  WHERE e.deleted_at IS NULL AND e.category IS NOT NULL AND trim(e.category) <> ''
    AND trim(e.description) <> ''
  UNION ALL
  SELECT se.created_by, lower(trim(se.description)), trim(se.category), se.updated_at, se.id, 'scheduled'
  FROM scheduled_expenses se
   WHERE se.category IS NOT NULL AND trim(se.category) <> ''
    AND trim(se.description) <> ''
), ranked AS (
  SELECT candidates.*,
    ROW_NUMBER() OVER (
      PARTITION BY user_id, normalized_description
      ORDER BY updated_at DESC, id DESC, source DESC
    ) AS preference_rank
  FROM candidates
)
INSERT INTO category_preferences(user_id, normalized_description, category, updated_at)
SELECT user_id, normalized_description, category, updated_at
FROM ranked
WHERE preference_rank = 1;
