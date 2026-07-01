-- spec-444: revert — drop video_welcomed_at from users.
ALTER TABLE users DROP COLUMN IF EXISTS video_welcomed_at;
