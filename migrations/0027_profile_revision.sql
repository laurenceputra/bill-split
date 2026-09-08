-- Profile revisions are allocated by SQLite, not by request clocks. An UPDATE
-- which commits obtains the next value while D1 serializes writers.
ALTER TABLE users ADD COLUMN profile_revision INTEGER NOT NULL DEFAULT 0 CHECK(profile_revision >= 0);
