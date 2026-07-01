-- spec-444: new-user welcome video modal — stamp when the user permanently dismisses.
ALTER TABLE users ADD COLUMN IF NOT EXISTS video_welcomed_at TIMESTAMPTZ;
