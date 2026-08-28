// POST /api/test-events — receives test pass/fail emissions from tests in the
// codebase tagged with an AC reference (canonical ref).
//
// ── Identity gate: per-memex emission key only (spec-90 dec-7, A1) ─────────
// There is NO server-owned-namespace guard. The b-90 Fix-4 design compared the
// ref's namespace to a MEMEX_OWN_NAMESPACE scalar — but memex.ai is multi-tenant
// (it serves every customer namespace, not just mindset-prod), so that scalar is
// the wrong identity key and rejected legitimately-keyed customer tenants
// (e.g. agent-craft) outright. The genuine safety check is spec-129's per-memex
// emission-key match: the bearer key must authorise the exact memex named in the
// ref (resolveMemexId(namespace, slug) == emissionKey.memexId). That proves the
// caller owns the target workspace regardless of namespace, so it is sufficient
// on its own. MEMEX_OWN_NAMESPACE and the wrong-namespace / fail-closed branches
// are removed.
//
// Payload (JSON body):
//   subject_ref      the verifiable-subject canonical ref — an AC ref OR a
//                    standard-clause ref (spec-151 dec-3). The neutral name.
//   ac_uid           LEGACY alias for subject_ref, still accepted (deprecated over
//                    a @memex-ai-ac/vitest version window). Exactly one of
//                    subject_ref / ac_uid is required; subject_ref wins if both sent.
//   status           required, one of 'pass' | 'fail' | 'error'
//   test_identifier  optional, text (typically file path + function name)
//   duration_ms      optional, integer
//   commit_sha       optional, text (the git SHA the test ran against). When
//                    absent, filled from metadata.commit (spec-528 dec-1 —
//                    note the name difference: `commit`, not `commit_sha`).
//   run_id           optional, text (groups events from one CI run). When
//                    absent, filled from metadata.run_id (spec-528 dec-1).
//                    Unlike actor below, these two ARE promoted from metadata:
//                    they have no competing top-level value, so the fallback
//                    overrides nothing and fills a column that would otherwise
//                    stay NULL for every client that has not upgraded.
//   actor            optional, text (spec-115 dec-6, spec-122) — WHO ran
//                    the test. Top-level sibling of hidden/metadata. The
//                    helper auto-populates from env vars; consumers can
//                    post explicitly. A metadata.actor key (legacy
//                    hand-rolled wire format) is stored opaquely as
//                    metadata but is NOT promoted into this column.
//   hidden           DEPRECATED (spec-358) — accepted for backward
//                    compatibility but NO LONGER HONOURED. An old / hand-rolled
//                    emitter may still send it (any value); it is silently
//                    ignored and the event is always stored as a counting
//                    result. No inbound value can keep a new result off the
//                    badge. (Historical hidden=true rows are frozen, untouched.)
//   metadata         optional, object<string,string> (spec-115 v0.1.0) —
//                    extensible context bag, surfaced in the UI tooltip.
//                    Server-side caps: 4KB total, 32 keys, 256 chars per
//                    value. Oversized keys are dropped, listed in the
//                    X-Memex-Warning response header; pass/fail still lands.
//
// Response: 201 with the inserted row id and timestamp on success;
//           201 with X-Memex-Warning header when metadata keys were dropped;
//           400 with reason on bad payload;
//           401 when the emission key is missing/invalid or does not authorise
//               the memex named in ac_uid (spec-129).
//
// Also logs every received event to stdout so observers can watch the
// stream during deploys and incident triage.
//
// ── Batch ingest: POST /api/test-events/batch (spec-489 G1) ────────────────
// Ingests MANY emissions in ONE authenticated request so a CI suite that tags N
// tests no longer fires N per-test POSTs (each taking a DB-pool slot) — it sends
// ~one request per test FILE instead. Body: { events: [ <same shape as above>,
// … ] } (1..MAX_BATCH_EVENTS). Auth is once per batch (the same Bearer key);
// each event is still independently memex-matched + spec-scope-gated, so a batch
// cannot write across a Memex boundary. Partial failure is non-fatal: bad events
// are reported per-index and the good ones still land. Response: 200 with
// { accepted, rejected, results: [{ index, ok, id?, status?, error? }] }. The
// single-event route above is unchanged and remains the documented protocol for
// hand-rolled emitters.

import { Hono } from "hono";
import { db } from "../db/connection.js";
import { testEvents } from "../db/schema.js";
import { applyEmissionToSummary } from "../services/test-event-latest.js";
import { applyEmissionToRollup } from "../services/test-run-daily.js";
import {
  trimTestEventsForPair,
  recordFirstVerified,
} from "../services/test-event-retention.js";
import { maybeAutoResolveIssuesForAcUid } from "../services/issues.js";
import { runWithMemexId } from "../db/connection.js";
import { fireVerifiedMilestoneForUser } from "../services/email/verified-milestone-send.js";
import {
  verifyEmissionKey,
  bumpLastUsed,
  resolveMemexId,
} from "../services/emission-keys.js";
import { mutate } from "../services/mutate.js";
// spec-533 t-2 (ac-19): the batching ratio is counted here, at ingest, because
// `test_events` cannot answer it — retention is by COUNT per (subject_ref,
// test_identifier) and no column records the route (dec-3 / dec-4).
import { recordEmissionAccepted } from "../observability/otel/index.js";
// spec-533 t-3 (dec-2/dec-3): the staleness advisory. It rides THIS route only —
// the batch route below sets no header at all, which is what makes "clients that
// already batch hear nothing" structural rather than a check anyone maintains.
import {
  STALENESS_ADVISORY,
  shouldAdvise,
  composeWarning,
} from "../services/emission-advisory.js";
import type { ChangeEntity } from "../services/bus.js";

const testEventsRouter = new Hono();

// spec-156 ac-16: the bus entity for an accepted CI test-event ingestion. The
// canonical ChangeEntity union lives in services/bus.ts (owned elsewhere this
// wave); rather than edit that file, we define the literal here and narrow it to
// ChangeEntity at the single emit site. When bus.ts gains a first-class
// "test_event" member this cast can be dropped. The SSE consumers that drive the
// AC-health surfaces (SpecList chips, Spec page counts) filter the per-Memex
// /events stream by memexId only, so emitting on the resolved memex is enough to
// trigger their refetch — no docId is required.
const TEST_EVENT_ENTITY = "test_event" as ChangeEntity;

interface TestEventBody {
  ac_uid?: unknown;
  // spec-151 dec-3: the neutral name for the verifiable-subject ref (AC ref OR
  // standard-clause ref). Dual-accepted alongside the legacy `ac_uid` field.
  subject_ref?: unknown;
  status?: unknown;
  test_identifier?: unknown;
  duration_ms?: unknown;
  commit_sha?: unknown;
  run_id?: unknown;
  actor?: unknown;
  hidden?: unknown;
  metadata?: unknown;
}

const VALID_STATUSES = new Set(["pass", "fail", "error"]);

// spec-115 dec-2: wire-format size caps for the metadata bag. Generous-by-
// default because tightening post-publish is breaking; loosening is not.
// Match the values documented in the package README and the ac-emission
// guidance topic.
export const META_MAX_TOTAL_BYTES = 4096;
export const META_MAX_KEYS = 32;
export const META_MAX_VALUE_CHARS = 256;

interface MetaValidationResult {
  metadata: Record<string, string>;
  dropped: string[];
}

// spec-115 dec-3: oversized metadata is dropped key-by-key, not truncated
// mid-string and not rejected wholesale. The verification signal (pass/fail
// status) is too important to lose to a metadata problem. Drops are named
// in the X-Memex-Warning response header so callers can fix their emitter
// without their dashboard going dark in the meantime.
//
// Drop policy: per-value cap is hard (>256 chars → drop key). For the
// key-count and total-bytes caps, drop the largest-value entries first.
// That preserves small contextual keys (actor, branch, commit) and sheds
// the bulky ones, which is usually what the user wants.
export function validateMetadata(
  input: Record<string, unknown>,
): MetaValidationResult {
  const dropped: string[] = [];

  let entries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "string" || value.length > META_MAX_VALUE_CHARS) {
      dropped.push(key);
      continue;
    }
    entries.push([key, value]);
  }

  const isOverCap = (e: Array<[string, string]>): boolean => {
    if (e.length > META_MAX_KEYS) return true;
    if (e.length === 0) return false;
    return (
      JSON.stringify(Object.fromEntries(e)).length > META_MAX_TOTAL_BYTES
    );
  };

  while (isOverCap(entries)) {
    entries.sort(([, a], [, b]) => b.length - a.length);
    const removed = entries.shift();
    if (!removed) break;
    dropped.push(removed[0]);
  }

  return { metadata: Object.fromEntries(entries), dropped };
}

function namespaceFromAcUid(subjectRef: string): string {
  const slashIdx = subjectRef.indexOf("/");
  return slashIdx > 0 ? subjectRef.slice(0, slashIdx) : "";
}

// Second path segment of an ac_uid (`<namespace>/<memex>/specs/...`). Used to confirm
// the authenticated key authorises the Memex named in the ref (spec-129 ac-10).
function memexSlugFromAcUid(subjectRef: string): string {
  const parts = subjectRef.split("/");
  return parts.length >= 2 ? parts[1]! : "";
}

// spec-234: the Spec handle from an ac_uid (`<namespace>/<memex>/specs/<spec-N>/acs/<ac-M>`).
// Used to enforce a spec-scoped (ephemeral / agent) key's scope. Returns "" when the ref
// isn't a `/specs/…` AC ref — a scoped key then matches nothing and is rejected, which is
// the safe default.
function specHandleFromAcUid(subjectRef: string): string {
  const parts = subjectRef.split("/");
  return parts.length >= 4 && parts[2] === "specs" ? parts[3]! : "";
}

// spec-489 G1: the maximum number of events one POST /batch may carry. Bounds
// the memory + DB work a single request can trigger so a batch cannot be used
// to exhaust an instance (std-39 — reason about cost/growth, not just
// correctness). A green CI file rarely tags more than a few dozen tests; 500 is
// generous headroom. An oversized batch is a hard 400, never a silent truncation.
export const MAX_BATCH_EVENTS = 500;

// spec-489 G1: the outcome of ingesting ONE event. Returned as data (not an HTTP
// response) so the single-event route and the batch route can each shape their
// own response from the same processing. On success `droppedKeys` names any
// metadata keys shed by the size caps (surfaced as a header on POST /, and
// inline per-event on POST /batch).
type ProcessResult =
  | { ok: true; id: string; createdAt: Date; status: string; droppedKeys: string[] }
  | { ok: false; code: 400 | 401; body: { error: string; message?: string } };

type VerifiedEmissionKey = NonNullable<Awaited<ReturnType<typeof verifyEmissionKey>>>;

// spec-489 G1: authenticate the emission key from the Authorization: Bearer
// header ONLY (spec-129 ac-8), BEFORE any payload work (ac-9). Shared by the
// single-event and batch routes so both gate identically. Returns the verified
// key, or the exact 401 body callers should return.
async function authenticateEmission(
  authHeader: string,
): Promise<
  | { ok: true; key: VerifiedEmissionKey }
  | { ok: false; body: { error: string; message: string } }
> {
  const rawKey = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";
  const key = rawKey ? await verifyEmissionKey(rawKey) : null;
  if (!key) {
    // spec-333 ac-6: verifyEmissionKey returns null for a missing, invalid, OR expired key
    // alike. Give ONE remedy that fits all three (no expiry oracle, per spec-333's Architecture
    // & Security section): a coding agent re-provisions over MCP; CI uses a human-minted key.
    return {
      ok: false,
      body: {
        error: "unauthorized",
        message:
          "A valid emission key is required (it may be missing, invalid, or expired). " +
          "If you are a coding agent, call the `provision_ac_emission` MCP tool with the " +
          "Spec you're working on to mint a fresh key, set it as MEMEX_EMIT_KEY in your " +
          "test environment, and re-run. For CI, a human mints a long-lived key in Memex " +
          "settings (Emission Keys) and stores it as the MEMEX_EMIT_KEY secret; the helper " +
          "attaches it as `Authorization: Bearer <key>`.",
      },
    };
  }
  return { ok: true, key };
}

// spec-489 G1: the per-event ingest pipeline, extracted from POST / so the
// single-event and the batched routes share ONE code path. A batched event
// therefore produces a byte-identical stored row to a one-per-POST event (ac-5:
// batching changes only how events travel, never what they mean).
//
// Authentication is NOT performed here — the caller verifies the emission key
// ONCE (authenticateEmission) and passes the resolved key in. Every event is
// still independently memex-matched (spec-129 ac-10) and spec-scope-gated
// (spec-234 ac-11) against that one key, so batching adds NO new way to write
// across a Memex boundary (ac-5). A per-event failure is returned as data; the
// batch caller keeps the good events (partial-failure) rather than discarding
// the whole batch.
async function processOneEvent(
  emissionKey: VerifiedEmissionKey,
  rawBody: unknown,
): Promise<ProcessResult> {
  if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) {
    return { ok: false, code: 400, body: { error: "event must be a JSON object" } };
  }
  const body = rawBody as TestEventBody;

  // spec-151 dec-3: dual-accept the neutral `subject_ref` field and the legacy
  // `ac_uid` wire field, mapping BOTH to the subject_ref column. `subject_ref`
  // wins when both are present; an old emitter sending only `ac_uid` still lands
  // (ac-10), and the same ref sent under either field produces an identical row
  // (ac-11). Deprecation of `ac_uid` rides a @memex-ai-ac/vitest version window.
  const subjectRefValue =
    typeof body.subject_ref === "string" && body.subject_ref.length > 0
      ? body.subject_ref
      : body.ac_uid;
  if (typeof subjectRefValue !== "string" || subjectRefValue.length === 0) {
    return {
      ok: false,
      code: 400,
      body: { error: "subject_ref (or legacy ac_uid) is required (string)" },
    };
  }
  if (typeof body.status !== "string" || !VALID_STATUSES.has(body.status)) {
    return {
      ok: false,
      code: 400,
      body: { error: "status is required and must be one of pass|fail|error" },
    };
  }
  if (body.test_identifier !== undefined && typeof body.test_identifier !== "string") {
    return { ok: false, code: 400, body: { error: "test_identifier must be a string when provided" } };
  }
  if (body.duration_ms !== undefined && typeof body.duration_ms !== "number") {
    return { ok: false, code: 400, body: { error: "duration_ms must be a number when provided" } };
  }
  if (body.commit_sha !== undefined && typeof body.commit_sha !== "string") {
    return { ok: false, code: 400, body: { error: "commit_sha must be a string when provided" } };
  }
  if (body.run_id !== undefined && typeof body.run_id !== "string") {
    return { ok: false, code: 400, body: { error: "run_id must be a string when provided" } };
  }
  if (body.actor !== undefined && typeof body.actor !== "string") {
    return { ok: false, code: 400, body: { error: "actor must be a string when provided" } };
  }
  // spec-358 (dec-3, ac-1/ac-11): the inbound `hidden` field is no longer
  // honoured. We still accept it for backward compatibility — an old /
  // hand-rolled emitter that sends it (any value, boolean or not) gets a
  // normal 201, never a 400 — but it is silently ignored. The stored row is
  // always a counting result (hidden=false below), so no emitter can keep a
  // NEW result off the badge (ac-2). Historical hidden=true rows are frozen
  // and untouched (dec-2/dec-5); the readers that exclude them are kept.
  if (
    body.metadata !== undefined &&
    (typeof body.metadata !== "object" ||
      body.metadata === null ||
      Array.isArray(body.metadata))
  ) {
    return { ok: false, code: 400, body: { error: "metadata must be an object when provided" } };
  }

  // spec-90 dec-7 (A1): no server-owned-namespace guard. The ref's namespace is
  // parsed only to resolve the target memex for the emission-key match below —
  // it is NOT compared against any server identity. memex.ai is multi-tenant, so
  // a cross-namespace ref from a legitimately-keyed tenant is expected and valid.
  const refNamespace = namespaceFromAcUid(subjectRefValue);

  // Authorization (spec-129 ac-10): a key only authorises emissions for its OWN Memex.
  // Resolve the memex named by the ref (<namespace>/<memex>/…) and confirm it matches the
  // authenticated key's memexId. This blocks cross-tenant tampering even with a valid key
  // for a different Memex.
  const targetMemexId = await resolveMemexId(
    refNamespace,
    memexSlugFromAcUid(subjectRefValue),
  );
  if (!targetMemexId || targetMemexId !== emissionKey.memexId) {
    return {
      ok: false,
      code: 401,
      body: {
        error: "unauthorized",
        message:
          "This emission key does not authorise the Memex named in the subject ref. A key only " +
          "works for the Memex it was generated in.",
      },
    };
  }

  // Spec-scope gate (spec-234 ac-11): an ephemeral / agent key carries a
  // scoped_spec_handle and may emit ONLY for ACs of that one Spec — so an in-progress
  // agent test run can't flip the verification bar of any other Spec on the shared
  // board. A permanent (CI) key has a NULL handle and keeps whole-memex authorisation,
  // so spec-129 keys are unaffected.
  if (
    emissionKey.scopedSpecHandle &&
    emissionKey.scopedSpecHandle !== specHandleFromAcUid(subjectRefValue)
  ) {
    // spec-333 ac-7: name BOTH the key's scoped Spec and the target Spec, and hand a coding
    // agent the exact provision_ac_emission call to get a key for the Spec it's actually
    // emitting for. The route already holds both handles, so the breadcrumb is precise.
    const targetSpecHandle = specHandleFromAcUid(subjectRefValue);
    const targetSpecRef = `${refNamespace}/${memexSlugFromAcUid(subjectRefValue)}/specs/${targetSpecHandle}`;
    return {
      ok: false,
      code: 401,
      body: {
        error: "unauthorized",
        message:
          `This emission key is scoped to Spec ${emissionKey.scopedSpecHandle} and cannot ` +
          `emit for Spec ${targetSpecHandle}. If you are a coding agent, call the ` +
          `\`provision_ac_emission\` MCP tool with ref ${targetSpecRef} to mint a key for ` +
          `that Spec, set it as MEMEX_EMIT_KEY, and re-run.`,
      },
    };
  }

  // spec-115 dec-2 / dec-3: validate metadata size caps and drop offending
  // keys server-side. The helper itself transmits caller-provided metadata
  // unmodified (ac-12); validation lives here so the protocol shape is
  // consistent regardless of which framework adapter (vitest/jest/pytest)
  // produced the emission.
  //
  // spec-528 t-3 (ac-3): `run_id`, `commit`, `branch` and `run_url` are stored
  // here AND — for the first two — promoted into columns below. That duplication
  // is load-bearing, not tidy-up debt: external readers learned to query
  // `metadata->>'run_id'` during the months the columns were empty, and `branch`
  // / `run_url` have no column at all. Do not prune these keys.
  let metadataForStorage: Record<string, string> | null = null;
  let droppedKeys: string[] = [];
  if (body.metadata !== undefined) {
    const result = validateMetadata(body.metadata as Record<string, unknown>);
    droppedKeys = result.dropped;
    metadataForStorage =
      Object.keys(result.metadata).length > 0 ? result.metadata : null;
  }

  // Capture the validated/narrowed fields into consts up front: the insert now
  // lives inside the mutate() callback, and TypeScript does not preserve the
  // `typeof body.ac_uid === "string"` narrowing across that function boundary.
  const insertValues = {
    subjectRef: subjectRefValue,
    // spec-398 dec-4 (ac-8): stamp tenancy at write from the Memex the emission
    // key already resolved + authorised above — no read-time ac_uid parsing.
    memexId: targetMemexId,
    status: body.status,
    testIdentifier: (body.test_identifier as string | undefined) ?? null,
    durationMs: (body.duration_ms as number | undefined) ?? null,
    // spec-528 dec-1: fill from `metadata` as a FALLBACK, never an override —
    // top-level wins whenever present; the metadata copy fills in only when the
    // top-level field is absent. Do NOT "simplify" the two sources into one: the
    // duplication is deliberate. The emitter has always collected these values
    // (packages/ac-emit-vitest/src/metadata.ts) and filed them under `metadata`,
    // so every client that has not upgraded — and every hand-rolled emitter —
    // becomes attributable on this deploy alone, with nothing to install (ac-2).
    //
    // Note the name difference across the boundary: the wire field is
    // `commit_sha`, the metadata key the emitter writes is `commit`.
    //
    // The precedence direction is dec-1's adopted READING of [per std-32] cl-20
    // — that cl-20 states a precedence rule (a top-level value must win over a
    // metadata copy) rather than a blanket ban on promotion. cl-20 is written
    // about `actor`, which unlike `run_id` does have a competing top-level value
    // and feeds a server-side identity resolver (spec-122 dec-8). If the owner of
    // std-32 reads cl-20 as a general prohibition, dec-1 needs revisiting.
    //
    // Read from the validated/narrowed metadata, not the raw body: the size and
    // shape caps (spec-115 dec-2/dec-3) have already been applied there, and
    // re-reading the raw bag would bypass them.
    commitSha:
      (body.commit_sha as string | undefined) ?? metadataForStorage?.commit ?? null,
    runId: (body.run_id as string | undefined) ?? metadataForStorage?.run_id ?? null,
    actor: (body.actor as string | undefined) ?? null,
    // spec-358: every ingested result counts. The inbound `hidden` field is
    // ignored — the row is always stored as a counting result. The column is
    // retained (dec-2) and write-frozen at false on this path.
    hidden: false,
    metadata: metadataForStorage,
  };

  // spec-115 dec-6: actor is the top-level field. A metadata.actor key (if
  // present in a hand-rolled payload) is stored opaquely as metadata but
  // is NOT promoted into this column. The canonical actor is the top-level.
  //
  // spec-156 ac-16 (std-8): the ingest write goes through mutate() so an accepted
  // CI test-event emits a `test_event.created` ChangeEvent. The per-Memex SSE
  // stream wakes the AC-health surfaces (SpecList chips, Spec page counts) to
  // refetch the instant a run posts — no longer reliant on AcPanel's 3s poll.
  // The bus key is the memex the AC lives under: spec-129's emission-key auth
  // already resolved it (targetMemexId) and proved it matches the key, so by
  // this point it is always a real, authorized Memex. Each batched event emits
  // its own bus frame here, exactly as a one-per-POST event would (ac-5).
  // spec-520 issue-8 (ac-22): establish tenant context around the WRITE, not only
  // around the auto-resolve READ further down.
  //
  // t-7 wrapped the read (ac-32), and that was the correct scope at the time: no
  // table written in this transaction carried RLS, so there was no policy for a
  // context-less write to fail. t-9's `test_run_daily` rollup is the first one
  // that does, and that turned a latent gap into an outage.
  //
  // Every tenant policy in drizzle/ carries an explicit
  // `nullif(current_setting('app.memex_id', true), '') IS NOT NULL` conjunct, so
  // an unset GUC makes the predicate FALSE rather than NULL. For SELECT/UPDATE
  // that filters to zero rows — quiet. For INSERT it RAISES. The rollup upsert
  // shares this transaction with the test_events insert and mutate() rethrows, so
  // without this wrap EVERY emission 500s in production — and the event itself is
  // lost too, not just the rollup row. Dev and CI stay green throughout, because
  // the owner role bypasses RLS (std-36: ENABLE, never FORCE). Proven red→green
  // under the real `memex_app` role in
  // test-events-tenant-context.rls-restricted.test.ts.
  //
  // The wrap goes around the whole transaction rather than around the one write
  // that needs it, so a write added in here later inherits the context instead of
  // having to remember it. std-36 asks for context "by construction, not
  // discipline"; this is the constructive half available at this layer. The other
  // half is db/rls-context-guard.ts (spec-440), still WARN-only at phase 1 — so
  // it would not have stopped this, which is why the wrap has to be structural.
  const writeEventAndSummaries = async () =>
    mutate(
    {},
    {
      memexId: targetMemexId,
      entity: TEST_EVENT_ENTITY,
      action: "created",
      // Carry the outcome on the event so the Pulse test-signal volume monitor
      // can colour the live tick (pass/fail/error) and surface failures in real
      // time. test_event is NOT persisted to activity_log (it's the firehose),
      // so this payload only ever rides the live SSE frame.
      payload: {
        status: insertValues.status,
        subjectRef: insertValues.subjectRef,
        hidden: insertValues.hidden,
      },
    },
    // spec-162 dec-1: append the log row AND upsert the test_event_latest
    // summary in one transaction so the two can't diverge on a crash. The
    // upsert skips hidden emissions (ac-6) and keys null test_identifier as ''
    // (ac-9). mutate() is not itself transactional — the db.transaction() here
    // is what makes the pair atomic. spec-489: in a batch these run
    // SEQUENTIALLY (one event at a time), so a batch holds ONE pool slot at a
    // time rather than one-per-event — the connection-pressure relief (std-39:
    // bound the connections/locks a request can hold).
    async () => {
      return db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(testEvents)
          .values(insertValues)
          .returning({ id: testEvents.id, createdAt: testEvents.createdAt });
        await applyEmissionToSummary(tx, {
          subjectRef: insertValues.subjectRef,
          memexId: targetMemexId,
          testIdentifier: insertValues.testIdentifier,
          status: insertValues.status as "pass" | "fail" | "error",
          latestRunAt: inserted.createdAt,
          hidden: insertValues.hidden,
        });
        // spec-520 t-9 (dec-5): the ANALYTICAL tier, in the same transaction as
        // the log write and the operational summary — so the counts can never
        // diverge from the rows they count, which is the failure this whole
        // rollup exists to end.
        //
        // Position is deliberate: immediately after the test_event_latest upsert
        // and before the retention trim, i.e. the same relative point on every
        // emission. spec-398's restructuring of this path deadlocked and rolled
        // back a prod deploy (std-39 cl-9); a consistent lock order is what
        // stops the repeat.
        //
        // NOT a second mutate() call, deliberately. The whole transaction is
        // already inside one (:467), which emits exactly one
        // `test_event.created` frame per emission. Wrapping this upsert in its
        // own mutate() would satisfy a naive reading of std-8 while DOUBLING the
        // SSE frames every emission puts on the bus — the surfaces that refetch
        // on that frame would then do it twice. std-8 is satisfied here the same
        // way applyEmissionToSummary satisfies it: by riding the enclosing
        // mutate()'s transaction.
        await applyEmissionToRollup(tx, {
          subjectRef: insertValues.subjectRef,
          memexId: targetMemexId,
          testIdentifier: insertValues.testIdentifier,
          status: insertValues.status as "pass" | "fail" | "error",
          runAt: inserted.createdAt,
          hidden: insertValues.hidden,
        });
        // spec-398 (ac-1): keep this pair bounded to the latest RETENTION_KEEP
        // runs — the steady-state trim-on-write, in the same transaction as the
        // insert so the log never transiently exceeds the cap.
        await trimTestEventsForPair(
          tx,
          insertValues.subjectRef,
          insertValues.testIdentifier,
        );
        // spec-398 t-6: durably snapshot the earliest pass BEFORE retention can
        // trim it away, so analytics keeps a true "first went green" date.
        if (insertValues.status === "pass" && !insertValues.hidden) {
          await recordFirstVerified(tx, insertValues.subjectRef, inserted.createdAt, targetMemexId);
        }
        return inserted;
      });
    },
  );

  const row = await runWithMemexId(targetMemexId, writeEventAndSummaries);

  // spec-129 ac-17: record that this key is live. Fire-and-forget (silent) so a missed
  // bump never blocks or fails the emission — it only leaves a slightly stale timestamp.
  bumpLastUsed(emissionKey.id);

  // spec-342: a test_event NEVER changes a Spec's phase. It updates the AC
  // verdict (applyEmissionToSummary, above) and the audit trail only; phase is
  // a deliberate human / handoff placement. The former build→verify (and
  // done→verify reopen) auto-promote was removed — see spec-traffic.ts.

  // Stdout log so observers can tail the dev server output during deploys
  // and behavioural probes. Cheap and useful.
  console.log(
    `[test-events] ${subjectRefValue} ${body.status}` +
      (body.test_identifier ? ` (${body.test_identifier})` : "") +
      // spec-528: report what was STORED, not what arrived top-level — otherwise
      // the log stays blank for every client whose run id rides in metadata.
      (insertValues.runId ? ` run=${insertValues.runId}` : ""),
  );

  // spec-112 ac-22: an AC may go green AFTER its satisfying Task is already
  // complete. The ingestion path is the second auto-resolve trigger — a passing
  // event for an AC that verifies a converted Issue's Task closes the
  // bug→failing-AC→green-AC→resolved loop. Best-effort: never fail the write.
  if (body.status === "pass") {
    // spec-520 t-7 (ac-32): run it INSIDE the tenant context. Without this the chain's
    // first statement — a `documents ⋈ memexes ⋈ namespaces` join — is filtered to zero
    // rows by `documents_memex_isolation` under the non-owner runtime role, so it concluded
    // "nothing to resolve" for 99.96% of passing events and spec-112 ac-22's second
    // auto-resolve trigger was dead in prod (issue-6).
    //
    // Three things kept it silent, which is why it needs a comment rather than just a fix:
    // the call is `.catch(() => {})` by design so a CI result write can never fail; the
    // owner role bypasses RLS so dev and the default suite cannot reproduce it; and the
    // tenant-context guard built for this class (spec-440) watches WRITES, not READS.
    // Proven under the restricted role in test-events-tenant-context.rls-restricted.test.ts.
    // try/catch, not just `.catch()`: a SYNCHRONOUS throw here escapes a trailing
    // `.catch` and 500s the event write. Observed while building this — a missing import
    // turned every passing emission into a 500. The old single-expression form had the
    // same hole; best-effort has to mean best-effort against both failure shapes.
    try {
      await runWithMemexId(targetMemexId, () =>
        maybeAutoResolveIssuesForAcUid(subjectRefValue),
      );
    } catch {
      // advisory by contract — an auto-resolve failure must never fail a CI result write
    }
    // spec-453 t-2 (dec-1/dec-4/dec-9): fire the "See it verified" milestone email.
    // FIRE-AND-FORGET — never awaited on this CI hot path, so it cannot add latency to
    // or break the write. Attributed to the emission key's OWNER (not test_events.actor),
    // gated first-ever + flag inside; fully advisory (its own try/catch swallows all).
    void fireVerifiedMilestoneForUser(emissionKey.createdByUserId);
  }

  return {
    ok: true,
    id: row.id,
    createdAt: row.createdAt,
    status: body.status,
    droppedKeys,
  };
}

// POST /api/test-events — ingest ONE test-event emission (spec-90 dec-7: the
// per-Memex emission key is the SOLE identity gate). Unchanged contract; the
// body processing now delegates to processOneEvent so it stays byte-identical
// to a batched event.
testEventsRouter.post("/", async (c) => {
  const auth = await authenticateEmission(c.req.header("Authorization") ?? "");
  if (!auth.ok) return c.json(auth.body, 401);

  let body: TestEventBody;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Body must be valid JSON" }, 400);
  }

  const result = await processOneEvent(auth.key, body);
  if (!result.ok) return c.json(result.body, result.code);

  // ONE header, never two: repeated response headers are read inconsistently by
  // the clients we know of (fetch comma-joins; Dart's HttpHeaders.value() raises
  // on multiple values, and the Dart emitter is a real reader). The specific fact
  // about THIS emission goes before the general advisory about the client's
  // configuration, and the dropped-keys warning is unchanged when the advisory
  // does not fire — spec-358 dec-3 expressly preserved it.
  const droppedWarning =
    result.droppedKeys.length > 0
      ? `metadata keys dropped (size limits exceeded): ${result.droppedKeys.join(", ")}`
      : null;
  const advisory = shouldAdvise() ? STALENESS_ADVISORY : null;
  const warning = composeWarning([droppedWarning, advisory]);
  if (warning !== null) c.header("X-Memex-Warning", warning);
  // One emission, one request: this is the ratio ≈ 1 end of the signal, and the
  // route arriving here IS the un-batched path (ac-19).
  recordEmissionAccepted(1, { route: "single" });
  return c.json({ id: result.id, created_at: result.createdAt }, 201);
});

// spec-489 G1 — POST /api/test-events/batch — ingest MANY emissions in ONE
// authenticated request. This is the durable relief for the CI-burst problem:
// a suite that tags N tests sends ~one request per test FILE instead of N
// per-test POSTs, so it no longer opens one connection-pool slot per test
// (ac-3). Semantics are identical to N single POSTs because every event runs
// through the same processOneEvent (ac-5).
//
//   Request : { "events": [ <same body as POST />, ... ] }   (1..MAX_BATCH_EVENTS)
//   Response: 200 { accepted, rejected, results: [{ index, ok, id?, status?, error? }] }
//
// Authentication is at the BATCH level (one Bearer key for the whole request);
// a missing/invalid/expired key 401s the whole batch before any DB work. Each
// event is still independently memex-matched + spec-scope-gated against that
// key, so a batch cannot write across a Memex boundary (ac-5). Partial failure
// is expected and non-fatal: a malformed or unauthorized event is reported in
// results[] with ok:false, and the good events in the same batch still land —
// a bad event never discards its neighbours (ac-5).
testEventsRouter.post("/batch", async (c) => {
  const auth = await authenticateEmission(c.req.header("Authorization") ?? "");
  if (!auth.ok) return c.json(auth.body, 401);

  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    return c.json({ error: "Body must be valid JSON" }, 400);
  }

  const events =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as { events?: unknown }).events
      : undefined;
  if (!Array.isArray(events)) {
    return c.json({ error: "events is required and must be an array" }, 400);
  }
  if (events.length === 0) {
    return c.json({ error: "events must contain at least one event" }, 400);
  }
  if (events.length > MAX_BATCH_EVENTS) {
    return c.json(
      { error: `events exceeds the maximum batch size of ${MAX_BATCH_EVENTS}` },
      400,
    );
  }

  // Process sequentially so the whole batch occupies ONE pool slot at a time
  // (std-39: bound the connections/locks a request holds) — the point of
  // batching is to relieve pool pressure, not to fan N inserts across N slots.
  const results: Array<{
    index: number;
    ok: boolean;
    id?: string;
    status?: string;
    error?: string;
    warning?: string;
  }> = [];
  let accepted = 0;
  let rejected = 0;
  for (let index = 0; index < events.length; index++) {
    const result = await processOneEvent(auth.key, events[index]);
    if (result.ok) {
      accepted++;
      results.push({
        index,
        ok: true,
        id: result.id,
        status: result.status,
        ...(result.droppedKeys.length > 0
          ? {
              warning: `metadata keys dropped (size limits exceeded): ${result.droppedKeys.join(", ")}`,
            }
          : {}),
      });
    } else {
      rejected++;
      results.push({
        index,
        ok: false,
        error: result.body.message ?? result.body.error,
      });
    }
  }

  // N emissions, ONE request. `accepted` rather than events.length: a partially
  // rejected batch counts what landed, which understates batching slightly and
  // never overstates adoption (ac-19).
  recordEmissionAccepted(accepted, { route: "batch" });
  return c.json({ accepted, rejected, results }, 200);
});

export { testEventsRouter };
