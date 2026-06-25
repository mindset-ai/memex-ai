-- spec-305 (dec-4 / dec-5): the captured onboarding profile on `users`.
--
-- `needsOnboarding` now keys off `identity_confirmed_at` (did the user complete the
-- Home Canvas identity step?) instead of `!name`. SSO users arrive WITH a name from
-- Google/Microsoft, so the old `!name` gate skipped them past onboarding entirely;
-- the journey still needs them to confirm that name and place themselves on the
-- developer/designer/PM triangle. `role_coords` stores that triangle as barycentric
-- weights {dev, design, pm} summing to 1.
ALTER TABLE users ADD COLUMN IF NOT EXISTS role_coords jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS identity_confirmed_at timestamptz;

-- Backfill: existing users who already have a name are treated as identity-confirmed,
-- so the new gate never drags an established user back through onboarding. New and
-- nameless users start unconfirmed and take the identity step on first /home landing.
-- (Mirrors the spec-213 onboarding_greeted_at backfill.)
UPDATE users
   SET identity_confirmed_at = now()
 WHERE name IS NOT NULL
   AND identity_confirmed_at IS NULL;
