-- spec-300 t-10 (dec-20): Memex-native capability flags on a Skill.
-- `{ codebaseAccess, codeEditing, externalTools }` authored at Skill-create time.
-- These INFORM downstream routing (which agent surface a Skill is offered to);
-- they are NOT a security boundary. Additive + nullable — only docType='skill'
-- rows populate it, every other document leaves it null. jsonb so the flag set
-- can grow without a further migration. The repo applies numbered hand-migrations
-- via apply-hand-migrations.mjs (the drizzle journal only owns up to 0008), so a
-- new numbered .sql is the correct pattern — mirrors 0009–0123.

ALTER TABLE documents ADD COLUMN IF NOT EXISTS skill_capabilities jsonb;
