-- t-13 of doc-15: domain-based auto-join consent (std-6).
--
-- Tracks every consent prompt the user has resolved. A row exists once the
-- user has accepted, declined, or skipped the prompt for a given (user, org)
-- pair — which makes the prompt sticky per std-6's "presented exactly once
-- per (user, org) pair" rule.
--
-- Why a separate table from `org_memberships`:
--   * Accept ⇒ insert into BOTH org_memberships AND this table. Membership =
--     access; this row = "we've already asked".
--   * Decline / skip ⇒ insert ONLY into this table. No membership.
--   * Disabled members are detected via org_memberships.status='disabled'
--     and short-circuit the consent flow entirely (per std-6: never silently
--     re-enable). No row inserted here for the disabled case.
--
-- Why `response` is enum-checked rather than a simple "dismissed" flag:
--   surfaces analytics ("how many users skip vs decline?") and lets the
--   product later distinguish behaviour (e.g. nudge declined users after a
--   month, never re-prompt skipped users).

CREATE TABLE "org_consent_responses" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "org_id" uuid NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "response" text NOT NULL,
  "responded_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "org_id"),
  CONSTRAINT "org_consent_responses_response_valid"
    CHECK ("response" IN ('accepted', 'declined', 'skipped'))
);
--> statement-breakpoint
CREATE INDEX "org_consent_responses_user_id_idx"
  ON "org_consent_responses" ("user_id");
