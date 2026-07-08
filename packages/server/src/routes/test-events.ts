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
//   commit_sha       optional, text (the git SHA the test ran against)
//   run_id           optional, text (groups events from one CI run)
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

import { Hono } from "hono";
import { db } from "../db/connection.js";
import { testEvents } from "../db/schema.js";
import { applyEmissionToSummary } from "../services/test-event-latest.js";
import {
  trimTestEventsForPair,
  recordFirstVerified,
} from "../services/test-event-retention.js";
import { maybeAutoResolveIssuesForAcUid } from "../services/issues.js";
import { fireVerifiedMilestoneForUser } from "../services/email/verified-milestone-send.js";
import {
  verifyEmissionKey,
  bumpLastUsed,
  resolveMemexId,
} from "../services/emission-keys.js";
import { mutate } from "../services/mutate.js";
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

testEventsRouter.post("/", async (c) => {
  // ── Emission-key auth (spec-129 dec-3) ──────────────────────────
  // A valid per-Memex key is required for every emission. Authenticate from the
  // Authorization: Bearer header ONLY (ac-8), BEFORE any payload work (ac-9).
  // The memex-match (ac-10) runs once ac_uid is known. This key match is the
  // SOLE identity gate — there is no server-owned-namespace check (spec-90 dec-7).
  const authHeader = c.req.header("Authorization") ?? "";
  const rawKey = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";
  const emissionKey = rawKey ? await verifyEmissionKey(rawKey) : null;
  if (!emissionKey) {
    // spec-333 ac-6: verifyEmissionKey returns null for a missing, invalid, OR expired key
    // alike. Give ONE remedy that fits all three (no expiry oracle, per spec-333's Architecture
    // & Security section): a coding agent re-provisions over MCP; CI uses a human-minted key.
    return c.json(
      {
        error: "unauthorized",
        message:
          "A valid emission key is required (it may be missing, invalid, or expired). " +
          "If you are a coding agent, call the `provision_ac_emission` MCP tool with the " +
          "Spec you're working on to mint a fresh key, set it as MEMEX_EMIT_KEY in your " +
          "test environment, and re-run. For CI, a human mints a long-lived key in Memex " +
          "settings (Emission Keys) and stores it as the MEMEX_EMIT_KEY secret; the helper " +
          "attaches it as `Authorization: Bearer <key>`.",
      },
      401,
    );
  }

  let body: TestEventBody;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Body must be valid JSON" }, 400);
  }

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
    return c.json(
      { error: "subject_ref (or legacy ac_uid) is required (string)" },
      400,
    );
  }
  if (typeof body.status !== "string" || !VALID_STATUSES.has(body.status)) {
    return c.json({ error: "status is required and must be one of pass|fail|error" }, 400);
  }
  if (body.test_identifier !== undefined && typeof body.test_identifier !== "string") {
    return c.json({ error: "test_identifier must be a string when provided" }, 400);
  }
  if (body.duration_ms !== undefined && typeof body.duration_ms !== "number") {
    return c.json({ error: "duration_ms must be a number when provided" }, 400);
  }
  if (body.commit_sha !== undefined && typeof body.commit_sha !== "string") {
    return c.json({ error: "commit_sha must be a string when provided" }, 400);
  }
  if (body.run_id !== undefined && typeof body.run_id !== "string") {
    return c.json({ error: "run_id must be a string when provided" }, 400);
  }
  if (body.actor !== undefined && typeof body.actor !== "string") {
    return c.json({ error: "actor must be a string when provided" }, 400);
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
    return c.json(
      { error: "metadata must be an object when provided" },
      400,
    );
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
    return c.json(
      {
        error: "unauthorized",
        message:
          "This emission key does not authorise the Memex named in the subject ref. A key only " +
          "works for the Memex it was generated in.",
      },
      401,
    );
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
    return c.json(
      {
        error: "unauthorized",
        message:
          `This emission key is scoped to Spec ${emissionKey.scopedSpecHandle} and cannot ` +
          `emit for Spec ${targetSpecHandle}. If you are a coding agent, call the ` +
          `\`provision_ac_emission\` MCP tool with ref ${targetSpecRef} to mint a key for ` +
          `that Spec, set it as MEMEX_EMIT_KEY, and re-run.`,
      },
      401,
    );
  }

  // spec-115 dec-2 / dec-3: validate metadata size caps and drop offending
  // keys server-side. The helper itself transmits caller-provided metadata
  // unmodified (ac-12); validation lives here so the protocol shape is
  // consistent regardless of which framework adapter (vitest/jest/pytest)
  // produced the emission.
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
    commitSha: (body.commit_sha as string | undefined) ?? null,
    runId: (body.run_id as string | undefined) ?? null,
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
  // this point it is always a real, authorized Memex.
  const row = await mutate(
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
    // is what makes the pair atomic.
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
          await recordFirstVerified(tx, insertValues.subjectRef, inserted.createdAt);
        }
        return inserted;
      });
    },
  );

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
      (body.run_id ? ` run=${body.run_id}` : ""),
  );

  if (droppedKeys.length > 0) {
    c.header(
      "X-Memex-Warning",
      `metadata keys dropped (size limits exceeded): ${droppedKeys.join(", ")}`,
    );
  }

  // spec-112 ac-22: an AC may go green AFTER its satisfying Task is already
  // complete. The ingestion path is the second auto-resolve trigger — a passing
  // event for an AC that verifies a converted Issue's Task closes the
  // bug→failing-AC→green-AC→resolved loop. Best-effort: never fail the 201.
  if (body.status === "pass") {
    await maybeAutoResolveIssuesForAcUid(subjectRefValue).catch(() => {});
    // spec-453 t-2 (dec-1/dec-4/dec-9): fire the "See it verified" milestone email.
    // FIRE-AND-FORGET — never awaited on this CI hot path, so it cannot add latency to
    // or break the 201. Attributed to the emission key's OWNER (not test_events.actor),
    // gated first-ever + flag inside; fully advisory (its own try/catch swallows all).
    void fireVerifiedMilestoneForUser(emissionKey.createdByUserId);
  }

  return c.json({ id: row.id, created_at: row.createdAt }, 201);
});

export { testEventsRouter };
