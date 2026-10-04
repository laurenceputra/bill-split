ALTER TABLE users ADD COLUMN avatar_mode TEXT NOT NULL DEFAULT 'initials' CHECK (avatar_mode IN ('initials', 'gravatar'));
