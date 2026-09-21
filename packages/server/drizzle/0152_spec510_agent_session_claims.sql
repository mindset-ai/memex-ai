-- spec-510 t-1 (dec-2, dec-3, dec-7): the cross-instance session-claim store.
--
-- WHAT IT ANSWERS. "Has this session already been sent this guidance?" The
-- cadence emits a static block in full on first sight and a one-line pointer
-- thereafter, so it needs a durable answer to that question.
--
-- WHY POSTGRES AND NOT AN IN-MEMORY MAP — precedent, then measurement.
-- spec-349 (migration 0105) exists BECAUSE a process-local Map "multiplied every
-- limit by the Cloud Run instance count (3) and reset on cold start". dec-7 then
-- measured the identical defect in this Spec's own antecedent: the process-local
-- Map in services/handoff-delivery.ts delivers the full phase handoff 2.672x per
-- (user, session, spec, phase) against a contract of 1, with 1,151 of 1,659
-- re-deliveries unexplained by its TTL. 2.672 is approximately the instance
-- count. An in-memory store here would make the saving a function of instance
-- count and deploy frequency — unprovable, while ac-6 promises the drop is
-- proven on live data or it does not ship.
--
-- SHAPE: ONE ROW PER SESSION (ac-11), with claims NAMESPACED inside it so two
-- mechanisms share one store without their key spaces colliding (dec-7):
--   handoff:{spec}:{phase} — the full phase handoff; backstop = idle TTL
--   block:{blockId}        — a static guidance block; backstop = byte threshold
-- `blockId` is the identifier spec-510 t-11 minted on GuidanceBlock; base blocks
-- carry kebab slugs, Org rows carry their org_scaffold_additions primary key.
--
-- This namespacing is what dissolves the apparent key conflict: `phase` stays IN
-- the handoff key, where spec-203 put it deliberately so a phase change re-primes
-- the agent, and OUT of the block key, where dec-3 excluded it deliberately so
-- suppression is not reset by a transition.
--
-- TWO MARKERS PER CLAIM, ONE READER EACH. Every claim records both `at` (when it
-- was granted) and `bytes` (the session's running guidance-byte total at that
-- moment). The handoff claim reads `at`; the block claim reads `bytes`. Storing
-- both costs nothing and means neither mechanism constrains the other's backstop.
--
-- WHY A RUNNING BYTE TOTAL AT ALL (dec-3). The safety net guards against ONE
-- failure: the agent's context was compacted, so it forgot a block it was shown.
-- Compaction is driven by transcript VOLUME, not elapsed time and not call count
-- — per-call variance is extreme (one measured get_doc returned 92,070 chars,
-- worth ~300 create_ac calls). "Bytes since this block was last shown in full"
-- is therefore `guidance_bytes - (claim ->> 'bytes')`, computed per block rather
-- than globally so a block first seen mid-session is not instantly due.
--
-- WRITE PATTERN IS THE LOAD-BEARING CHOICE [per std-39], not the schema. Every
-- claim is a SINGLE atomic `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`
-- (services/session-claims.ts), mirroring services/auth-rate-limit.ts, so
-- concurrent instances serialise on the row lock instead of racing. The failure
-- that pattern prevents is two instances both reading "not yet claimed" and both
-- emitting the full block. Time is computed in-DB via now() so instances agree
-- regardless of clock skew.
--
-- NO RLS, DELIBERATELY [per std-36 — recorded here, as 0105 recorded its own].
-- The row is keyed on an MCP session id (or, for the in-app agent, its
-- conversation thread). Neither is tenant data: no memex_id, no org_id, no
-- namespace, and nothing user-authored is stored — only claim identifiers, a
-- timestamp and a byte count. There is therefore no tenant boundary for RLS to
-- enforce, exactly as for rate_limit_counters. If a memex_id is ever added to
-- this row, std-36 applies in full: ENABLE, never FORCE, with runWithMemexId
-- setting the GUC.
--
-- GROWTH [per std-39]. Rows are BOUNDED IN SIZE and unbounded in count: a
-- session's claims blob cannot exceed the number of distinct blocks it sees
-- (52 base blocks today plus any Org additions), while rows accrue at roughly
-- the session rate — 12,662 sessions per 30 days in the spec-472 Track B pull,
-- so order 150k rows a year at today's volume. Small, but it only grows.
-- `updated_at` carries an index so a future sweep is a cheap ranged delete
-- rather than a full scan — the index is the part that is awkward to add later
-- under load; the delete is easy. THE SWEEPER IS NOT BUILT HERE: it is
-- spec-510 issue-5, registered so the omission has an owner rather than being
-- silent. Note the contrast with rate_limit_counters, whose rows are
-- self-limiting by construction (`reset_at` expires every one of them); a
-- session claim has no natural expiry, so its horizon is a deliberate choice.
CREATE TABLE IF NOT EXISTS agent_session_claims (
  session_id text PRIMARY KEY,
  guidance_bytes bigint NOT NULL DEFAULT 0,
  claims jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- Lets a future sweep drop idle sessions by age without a full scan (see GROWTH
-- above). Mirrors rate_limit_counters_reset_at_idx's purpose.
CREATE INDEX IF NOT EXISTS agent_session_claims_updated_at_idx
  ON agent_session_claims (updated_at);
--> statement-breakpoint

-- The restricted runtime role (memex_app, created in 0081) is the one that serves
-- requests on Cloud Run. ALTER DEFAULT PRIVILEGES in 0081 already grants on tables
-- created afterwards, but — mirroring 0100 and 0105 — we GRANT explicitly so the
-- privilege does not depend on the creating role matching the default-privileges
-- grantor. No RLS is enabled on this table, so memex_app operates on it directly.
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_session_claims TO memex_app;
