-- spec-213 t-1 (dec-1 / ac-5): backfill onboarding_greeted_at for pre-existing users.
--
-- spec-206 added the first-run greeting, gated server-side on
-- `onboarding_greeted_at IS NULL` (routes/onboarding.ts). Its schema migration
-- (0082) added the column as NULLABLE with NO backfill, so EVERY user who already
-- existed reads as null → eligible → auto-greeted on their next landing. That is
-- wrong: the greeting is meant only for people arriving in Memex for the FIRST
-- TIME IN HISTORY, not the entire pre-existing user base.
--
-- The gate logic is correct; only the historical data population is wrong. This
-- migration draws the line at deploy time: every user who already exists is, by
-- definition, not a first-time arrival, so we stamp them as already-greeted. After
-- this runs:
--   * existing users      → non-null → greet=false → never auto-greeted (ac-6)
--   * new signups (later)  → null    → greet=true  → greeted exactly once (ac-7)
--
-- Idempotent + safe to re-run: the WHERE clause only touches still-null rows, so a
-- row that already carries a timestamp (a user who was genuinely greeted, on any
-- device) is left untouched and never re-stamped (ac-8). The hand-migration runner
-- tracks this file in `manual_migrations` and wraps it in a single transaction, so
-- it applies exactly once per database on the CI/CD `db:migrate` path (INT on
-- develop, PROD on main).
--
-- One-way data correction: the revert is a documented no-op — once stamped, a
-- backfilled row is indistinguishable from a naturally-greeted one, so there is
-- nothing safe to roll back to.

UPDATE users
   SET onboarding_greeted_at = now()
 WHERE onboarding_greeted_at IS NULL;
