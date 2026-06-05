// POST /api/test-events — receives test pass/fail emissions from tests in the
// codebase tagged with an AC reference (canonical ref).
//
// ── Cross-namespace safety net (b-90 dec-4, dec-5) ────────────────────────
// Each Memex server knows its own namespace identity via the
// `MEMEX_OWN_NAMESPACE` env var (set per-env in scripts/deploy-config.sh).
// The route rejects events for refs whose namespace doesn't match the
// server's own, returning a 4xx whose body names the correct canonical
// destination. This catches cross-namespace misroutes at the destination
// even if the helper is misconfigured, bypassed, or hand-rolled (curl).
//
// When `MEMEX_OWN_NAMESPACE` is unset, the route fail-closes: every POST
// returns 4xx. Local-dev devs running tests against a local Memex server
// must set MEMEX_OWN_NAMESPACE explicitly to opt in.
//
// Payload (JSON body):
//   ac_uid           required, text (the AC's full canonical ref)
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
//   hidden           optional, boolean (spec-115 v0.1.0) — when true, the
//                    event is stored but excluded from the AC's displayed
//                    verification badge calculation
//   metadata         optional, object<string,string> (spec-115 v0.1.0) —
//                    extensible context bag, surfaced in the UI tooltip.
//                    Server-side caps: 4KB total, 32 keys, 256 chars per
//                    value. Oversized keys are dropped, listed in the
//                    X-Memex-Warning response header; pass/fail still lands.
//
// Response: 201 with the inserted row id and timestamp on success;
//           201 with X-Memex-Warning header when metadata keys were dropped;
//           400 with reason on bad payload;
//           503 when MEMEX_OWN_NAMESPACE is unset (server has no identity);
//           400 with `error: 'wrong-namespace'` for cross-namespace events.
//
// Also logs every received event to stdout so observers can watch the
// stream during deploys and incident triage.

import { Hono } from "hono";
import { db } from "../db/connection.js";
import { testEvents } from "../db/schema.js";
import { applyEmissionToSummary } from "../services/test-event-latest.js";
import { maybeAutoResolveIssuesForAcUid } from "../services/issues.js";
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

// Namespace → canonical destination URL. Mirrors the helper's
// NAMESPACE_TO_BASE_URL table; lives here so the 4xx body can name the
// correct canonical destination for a misrouted ref.
const NAMESPACE_TO_BASE_URL: Record<string, string> = {
  "mindset-int": "https://int.memex.ai",
  "mindset-prod": "https://memex.ai",
};

function canonicalUrlFor(namespace: string): string | undefined {
  const base = NAMESPACE_TO_BASE_URL[namespace];
  return base ? `${base}/api/test-events` : undefined;
}

function namespaceFromAcUid(acUid: string): string {
  const slashIdx = acUid.indexOf("/");
  return slashIdx > 0 ? acUid.slice(0, slashIdx) : "";
}

// Second path segment of an ac_uid (`<namespace>/<memex>/specs/...`). Used to confirm
// the authenticated key authorises the Memex named in the ref (spec-129 ac-10).
function memexSlugFromAcUid(acUid: string): string {
  const parts = acUid.split("/");
  return parts.length >= 2 ? parts[1]! : "";
}

testEventsRouter.post("/", async (c) => {
  // ── Cross-namespace safety net ──────────────────────────────
  // Read MEMEX_OWN_NAMESPACE EXCLUSIVELY from process.env. No host-derivation,
  // no PUBLIC_HOST/APP_BASE_URL inference (per dec-5 + ac-11). If the env var
  // is unset, fail-closed: 503 every request with a body naming the missing
  // env var + remediation (per dec-4 + ac-7, ac-8).
  const ownNamespace = process.env.MEMEX_OWN_NAMESPACE;
  if (!ownNamespace) {
    return c.json(
      {
        error: "missing-config",
        message:
          "MEMEX_OWN_NAMESPACE is not set on this server. /api/test-events " +
          "is fail-closed without it (the cross-namespace safety net cannot " +
          "operate). Set MEMEX_OWN_NAMESPACE in the server's environment to " +
          "the namespace this server owns (e.g. 'mindset-int' or " +
          "'mindset-prod') to enable test-event ingestion.",
      },
      503,
    );
  }

  // ── Emission-key auth (spec-129 dec-3) ──────────────────────────
  // A valid per-Memex key is required for every emission. Authenticate from the
  // Authorization: Bearer header ONLY (ac-8), AFTER the server-identity 503 check and
  // BEFORE any payload work (ac-9). The memex-match (ac-10) runs once ac_uid is known.
  const authHeader = c.req.header("Authorization") ?? "";
  const rawKey = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";
  const emissionKey = rawKey ? await verifyEmissionKey(rawKey) : null;
  if (!emissionKey) {
    return c.json(
      {
        error: "unauthorized",
        message:
          "A valid emission key is required. Generate one in Memex settings " +
          "(Emission Keys) and set it as MEMEX_EMIT_KEY in your test environment; " +
          "the helper attaches it as `Authorization: Bearer <key>`.",
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

  if (typeof body.ac_uid !== "string" || body.ac_uid.length === 0) {
    return c.json({ error: "ac_uid is required (string)" }, 400);
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
  if (body.hidden !== undefined && typeof body.hidden !== "boolean") {
    return c.json({ error: "hidden must be a boolean when provided" }, 400);
  }
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

  // Cross-namespace check: if the ref names a namespace this server doesn't
  // own, reject with a body that names the correct canonical destination
  // (per dec-4 + ac-5). Even if the client's helper is misconfigured, the
  // 4xx body tells them where the event SHOULD have gone.
  const refNamespace = namespaceFromAcUid(body.ac_uid);
  if (refNamespace !== ownNamespace) {
    const expectedDestination = canonicalUrlFor(refNamespace);
    return c.json(
      {
        error: "wrong-namespace",
        message:
          `This server owns ${ownNamespace}; received ac_uid in namespace ` +
          `${refNamespace || "(empty)"}. The event was rejected — repoint ` +
          `your emitter at the correct destination.`,
        ...(expectedDestination ? { expectedDestination } : {}),
      },
      400,
    );
  }

  // Authorization (spec-129 ac-10): a key only authorises emissions for its OWN Memex.
  // Resolve the memex named by ac_uid (<namespace>/<memex>/…) and confirm it matches the
  // authenticated key's memexId. This blocks cross-tenant tampering even with a valid key
  // for a different Memex.
  const targetMemexId = await resolveMemexId(
    refNamespace,
    memexSlugFromAcUid(body.ac_uid),
  );
  if (!targetMemexId || targetMemexId !== emissionKey.memexId) {
    return c.json(
      {
        error: "unauthorized",
        message:
          "This emission key does not authorise the Memex named in ac_uid. A key only " +
          "works for the Memex it was generated in.",
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
    acUid: body.ac_uid,
    status: body.status,
    testIdentifier: (body.test_identifier as string | undefined) ?? null,
    durationMs: (body.duration_ms as number | undefined) ?? null,
    commitSha: (body.commit_sha as string | undefined) ?? null,
    runId: (body.run_id as string | undefined) ?? null,
    actor: (body.actor as string | undefined) ?? null,
    hidden: (body.hidden as boolean | undefined) ?? false,
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
          acUid: insertValues.acUid,
          testIdentifier: insertValues.testIdentifier,
          status: insertValues.status as "pass" | "fail" | "error",
          latestRunAt: inserted.createdAt,
          hidden: insertValues.hidden,
        });
        return inserted;
      });
    },
  );

  // spec-129 ac-17: record that this key is live. Fire-and-forget (silent) so a missed
  // bump never blocks or fails the emission — it only leaves a slightly stale timestamp.
  bumpLastUsed(emissionKey.id);

  // Stdout log so observers can tail the dev server output during deploys
  // and behavioural probes. Cheap and useful.
  console.log(
    `[test-events] ${body.ac_uid} ${body.status}` +
      (body.test_identifier ? ` (${body.test_identifier})` : "") +
      (body.run_id ? ` run=${body.run_id}` : "") +
      (body.hidden === true ? " [hidden]" : ""),
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
    await maybeAutoResolveIssuesForAcUid(body.ac_uid).catch(() => {});
  }

  return c.json({ id: row.id, created_at: row.createdAt }, 201);
});

export { testEventsRouter };
