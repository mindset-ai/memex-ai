-- spec-426 — Experiments: a Backstage-owned A/B construct for stating an intended
-- outcome and A/B-testing a change against it (the first operational slice of
-- spec-109's hypothesis layer). Three platform-global tables:
--
--   experiments            — the experiment: a plain-language statement, a status
--                            (draft → running → concluded), and the outcome rule
--                            (success predicate + a per-experiment window in DAYS,
--                            default 7 — spec-426 dec-2; per-experiment, NOT a
--                            global constant).
--   experiment_variants    — the arms (A = control / B = treatment). Each carries a
--                            behaviour id into a CODE-SIDE registry (dec-4):
--                            'handhold_demo' → the fixed demo, 'starter_spec' → the
--                            seeded "Understanding Memex" spec. Unknown id falls
--                            back to control rather than failing signup.
--   experiment_assignments — user ↔ variant ↔ time, plus who/what assigned it
--                            (auto / operator / agent — std-32 HOW) and the decided
--                            verdict inline (pending → succeeded | failed). The auto
--                            assignment is a deterministic hash(user_id) → 50/50
--                            split at provisioning (dec-6), recorded and
--                            agent-overridable. ONE active (superseded_at IS NULL)
--                            assignment per (user, experiment); a reassignment
--                            supersedes the prior row, retaining history.
--
-- Core (memex-ai) OWNS + WRITES these public tables; Backstage READS them
-- cross-tenant via the memex_admin BYPASSRLS role and the @mindset-ai/db-schema
-- export (spec-279 / spec-280). The 3-hourly sweep (dec-1) stamps each assignment's
-- verdict; Memex TALLIES decided booleans, it never computes analytics (spec-109).
--
-- RLS — deliberately EXCLUDED, mirroring comms_log (drizzle/0104), usage_events
-- (drizzle/0090) and visitors (drizzle/0096). The "God agent associates ANY user
-- with a variant" requirement is inherently CROSS-TENANT, so these tables carry NO
-- memex_id and sit OUTSIDE the per-tenant RLS policy of std-36 — a memex_id USING
-- clause is meaningless on a user-keyed, platform-global row, and a FORCE-RLS WITH
-- CHECK would silently reject the provisioning-path insert (which runs with no
-- request ALS / tenant GUC). Isolation is enforced at the service layer and, in
-- Backstage, by the requireOperator / isDevMode gate (routes/backstage.ts). The
-- rows hold only ids / enums / metadata (no credentials, no bodies). Same
-- justification comms_log / usage_events / visitors carry. Do NOT add
-- ENABLE ROW LEVEL SECURITY to any table below.
--
-- Idempotent (IF NOT EXISTS): the hand-migration runner wraps each file in a
-- transaction and tracks it in manual_migrations; the guards let a retry re-apply
-- cleanly if a prior run committed the DDL but not the tracking row.

CREATE TABLE IF NOT EXISTS "experiments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "key" text NOT NULL UNIQUE,
  "statement" text NOT NULL,
  "status" text NOT NULL DEFAULT 'draft',
  "outcome_rule" jsonb,
  "window_days" integer NOT NULL DEFAULT 7,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
  "created_by_name" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "experiments_status_valid" CHECK ("status" IN ('draft', 'running', 'concluded')),
  CONSTRAINT "experiments_window_days_positive" CHECK ("window_days" > 0)
);

CREATE TABLE IF NOT EXISTS "experiment_variants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "experiment_id" uuid NOT NULL REFERENCES "experiments"("id") ON DELETE cascade,
  "key" text NOT NULL,
  "label" text NOT NULL,
  "description" text,
  "is_control" boolean NOT NULL DEFAULT false,
  "behaviour" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "experiment_variants_key_valid" CHECK ("key" IN ('A', 'B')),
  CONSTRAINT "experiment_variants_behaviour_valid" CHECK ("behaviour" IN ('handhold_demo', 'starter_spec'))
);

-- One row per (experiment, arm key).
CREATE UNIQUE INDEX IF NOT EXISTS "experiment_variants_experiment_key_unique"
  ON "experiment_variants" ("experiment_id", "key");
CREATE INDEX IF NOT EXISTS "experiment_variants_experiment_id_idx"
  ON "experiment_variants" ("experiment_id");

CREATE TABLE IF NOT EXISTS "experiment_assignments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "experiment_id" uuid NOT NULL REFERENCES "experiments"("id") ON DELETE cascade,
  "variant_id" uuid NOT NULL REFERENCES "experiment_variants"("id") ON DELETE cascade,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
  "assigned_by" text NOT NULL,
  "assigned_by_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
  "reason" text,
  "superseded_at" timestamp with time zone,
  "outcome" text NOT NULL DEFAULT 'pending',
  "decided_at" timestamp with time zone,
  CONSTRAINT "experiment_assignments_assigned_by_valid" CHECK ("assigned_by" IN ('auto', 'operator', 'agent')),
  CONSTRAINT "experiment_assignments_outcome_valid" CHECK ("outcome" IN ('pending', 'succeeded', 'failed'))
);

-- Per-user lookup (every assignment for one human) and per-experiment scans (the
-- sweep + the Backstage tally).
CREATE INDEX IF NOT EXISTS "experiment_assignments_user_id_idx"
  ON "experiment_assignments" ("user_id");
CREATE INDEX IF NOT EXISTS "experiment_assignments_experiment_id_idx"
  ON "experiment_assignments" ("experiment_id");

-- Enforce ONE active assignment per (user, experiment). Partial on the
-- not-superseded set so superseded history rows don't collide (dec-6 reassignment).
CREATE UNIQUE INDEX IF NOT EXISTS "experiment_assignments_active_user_experiment_unique"
  ON "experiment_assignments" ("user_id", "experiment_id")
  WHERE "superseded_at" IS NULL;
