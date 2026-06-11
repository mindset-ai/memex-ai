-- spec-254 t-1 — visitors: the anonymous-first identity spine.
--
-- One durable id per browser, minted at first touch BEFORE any sign-in (the
-- .memex.ai first-party cookie value, mirrored to localStorage), carried on every
-- event. At sign-in the anonymous visitor_id MERGES into the now-known user (the
-- analytics "identify" step): user_id + merged_at get stamped. This is the
-- browser-only slice (spec-254 dec-2) and the embryo of spec-125's dim_actor.
--
-- Bind-once invariant (spec-254 dec-3): a visitor_id binds to at most one user,
-- ever. The merge is an atomic conditional UPDATE ... WHERE user_id IS NULL; a
-- merge against an already-bound id for a DIFFERENT user does NOT overwrite — the
-- caller mints a fresh visitor_id. Erasure-reversible: user delete sets user_id
-- NULL (not cascade), so nulling the row breaks the link without losing the
-- anonymous arc.
--
-- RLS — deliberately EXCLUDED, mirroring usage_events / activity_log (drizzle/0081
-- §exclusions, 0090). The visitorMiddleware writes pre-auth from a request with no
-- tenant ALS context (a FORCE-RLS WITH CHECK would silently reject those inserts),
-- and visitors is a CROSS-TENANT identity dimension, not tenant-scoped data (a
-- memex_id-keyed USING clause is meaningless here). The row holds only an opaque
-- id + the resolved user_id (no content, no credentials). Access is mediated at the
-- service layer (recordVisitor / mergeVisitor) and the merge takes user_id only
-- from the authenticated session.

CREATE TABLE IF NOT EXISTS "visitors" (
  "visitor_id" uuid PRIMARY KEY NOT NULL,
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "user_id" uuid REFERENCES "users"("id") ON DELETE set null,
  "merged_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Reverse lookup: every visitor id that resolved to a given user (per-user journey
-- reconstruction / cohort joins, spec-254 ac-3). Partial — only merged rows carry a
-- user_id, so the index stays small.
CREATE INDEX IF NOT EXISTS "visitors_user_id_idx"
  ON "visitors" ("user_id")
  WHERE "user_id" IS NOT NULL;
