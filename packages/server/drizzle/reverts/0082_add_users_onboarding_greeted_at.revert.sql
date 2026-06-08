-- Revert spec-206 t-1 (0082_add_users_onboarding_greeted_at.sql).
ALTER TABLE users DROP COLUMN IF EXISTS onboarding_greeted_at;
