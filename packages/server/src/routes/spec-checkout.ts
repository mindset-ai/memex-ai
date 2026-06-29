// POST /api/spec-checkout — the RECORD-ONLY phone-home (spec-371).
//
// The client-side checkout hook calls this on a file edit, and ONLY when the
// local marker says this thread is claimed — the privacy gate is client-side
// (dec-2), so an unclaimed / non-Memex thread never reaches here at all. Here we:
//   1. authenticate the dedicated HOOK KEY (Bearer) — never the user's MCP auth
//      (dec-6); a wrong / missing / revoked key is 401.
//   2. confirm the key authorises the spec's Memex (cross-tenant → 401), exactly
//      like the test-events emission-key guard.
//   3. record ONE durable edit row (the footprint join key) + beat presence so
//      the holder shows as "working on spec-N now" (dec-5).
//   4. return a minimal ack. RECORD-ONLY: the response carries NO steering
//      payload (dec-8). Steering — 132's GPS verdict, 359's standards — is a
//      later consumer of this stream, not part of this foundation.
//
// Modeled on routes/test-events.ts (the other Bearer-key, body-resolved-tenant
// endpoint). A ref that names no accessible / open spec fails QUIET (records
// nothing, 200) rather than erroring — a hook must never go noisy (std-7).

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db, runWithMemexId } from "../db/connection.js";
import { documents } from "../db/schema.js";
import { verifyHookKey, bumpHookKeyLastUsed } from "../services/hook-keys.js";
import { resolveMemexId } from "../services/emission-keys.js";
import { getOrgIdForMemex } from "../services/memexes.js";
import { isActiveOrgMember } from "../services/org-memberships.js";
import { recordCheckoutEdit } from "../services/spec-checkout.js";
import { setCheckoutThread } from "../services/checkout.js";

const specCheckoutRouter = new Hono();

interface EditBody {
  ref?: unknown;
  thread_uid?: unknown;
  changed_paths?: unknown;
  commit_sha?: unknown;
  branch?: unknown;
}

// "<namespace>/<memex>/specs/<spec-N>[/...]" → parts. null when not a spec ref.
function parseSpecRef(
  ref: string,
): { namespace: string; memexSlug: string; specHandle: string } | null {
  const parts = ref.split("/");
  if (parts.length < 4 || parts[2] !== "specs") return null;
  return { namespace: parts[0]!, memexSlug: parts[1]!, specHandle: parts[3]! };
}

// POST /api/spec-checkout (2-segment, mirrors /api/test-events). NOT /edit: a
// 3-segment flat route with no /api/:namespace/:memex twin is silently dropped by
// Hono's RegExpRouter in the full app (registered but never matched → 404). The
// record-only sibling test-events posts to its router root for the same reason.
specCheckoutRouter.post("/", async (c) => {
  // ── Hook-key auth (dec-6) — the dedicated scoped credential, never the PAT ──
  const authHeader = c.req.header("Authorization") ?? "";
  const rawKey = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";
  const hookKey = rawKey ? await verifyHookKey(rawKey) : null;
  if (!hookKey) {
    return c.json(
      {
        error: "unauthorized",
        message:
          "A valid hook key is required (it may be missing, invalid, or revoked). " +
          "Re-run the Memex plugin install to plant a fresh one.",
      },
      401,
    );
  }

  let body: EditBody;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Body must be valid JSON" }, 400);
  }
  if (typeof body.ref !== "string" || body.ref.length === 0) {
    return c.json({ error: "ref is required (string)" }, 400);
  }
  if (typeof body.thread_uid !== "string" || body.thread_uid.length === 0) {
    return c.json({ error: "thread_uid is required (string)" }, 400);
  }
  if (
    !Array.isArray(body.changed_paths) ||
    !body.changed_paths.every((p) => typeof p === "string")
  ) {
    return c.json({ error: "changed_paths is required (string[])" }, 400);
  }
  if (body.commit_sha !== undefined && typeof body.commit_sha !== "string") {
    return c.json({ error: "commit_sha must be a string when provided" }, 400);
  }
  if (body.branch !== undefined && typeof body.branch !== "string") {
    return c.json({ error: "branch must be a string when provided" }, 400);
  }

  const parsed = parseSpecRef(body.ref);
  // Not a spec ref → fail quiet, record nothing (std-7). Never an error.
  if (!parsed) return c.json({ recorded: false, reason: "not_a_spec_ref" }, 200);

  // Authorize by MEMBERSHIP (spec-430 dec-1): a user-scoped key (memexId NULL) writes
  // for ANY memex its creator is an active member of, so a personal->org graduation
  // needs no new key (ac-5). A legacy per-memex key (memexId set) is additionally
  // pinned to its own memex. Tenant isolation is membership + RLS, not key
  // granularity. These lookups read the CONTROL PLANE (memexes/orgs/org_memberships),
  // not RLS-tenant tables, so they run correctly before the runWithMemexId wrap below.
  const memexId = await resolveMemexId(parsed.namespace, parsed.memexSlug);
  const actorUserId = hookKey.createdByUserId ?? null;
  const scopeOk = hookKey.memexId === null || hookKey.memexId === memexId;
  const orgId = memexId ? await getOrgIdForMemex(memexId) : null;
  const authorized =
    !!memexId && scopeOk && !!actorUserId && !!orgId && (await isActiveOrgMember(actorUserId, orgId));
  if (!authorized) {
    return c.json(
      {
        error: "unauthorized",
        message: "This hook key does not authorise the Memex named in ref.",
      },
      401,
    );
  }

  // body.thread_uid was validated as a string above, but TypeScript does not preserve
  // that narrowing across the runWithMemexId callback boundary below — hoist it (the
  // same reason test-events.ts captures its insert values before the mutate() callback).
  const threadUid = body.thread_uid;

  // Everything below reads/writes TENANT tables (documents, then spec_checkout_edits)
  // under row-level security (std-36): the policy filters every row unless `app.memex_id`
  // is set, and the Cloud Run runtime role `memex_app` is a NON-OWNER, so the policy
  // applies to it in full. The hook-key auth + resolveMemexId above run on RLS-EXCLUDED
  // tables, so they need no context — but the spec lookup does. runWithMemexId stamps
  // app.memex_id for the duration. WITHOUT this wrap the read returns zero rows on int
  // (every phone-home silently records nothing), while local tests pass because the
  // postgres superuser bypasses RLS — the exact 2026-06-10 emission-outage trap
  // (see emission-key-contextless-verify.regression).
  return runWithMemexId(memexId, async () => {
    // Resolve the spec doc. Unknown spec → fail quiet (std-7), record nothing.
    const [doc] = await db
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(
          eq(documents.memexId, memexId),
          eq(documents.handle, parsed.specHandle),
          eq(documents.docType, "spec"),
        ),
      )
      .limit(1);
    if (!doc) return c.json({ recorded: false, reason: "spec_not_found" }, 200);

    await recordCheckoutEdit({
      memexId,
      docId: doc.id,
      threadUid,
      changedPaths: body.changed_paths as string[],
      commitSha: (body.commit_sha as string | undefined) ?? null,
      branch: (body.branch as string | undefined) ?? null,
      actorUserId,
    });

    // Reconcile checked_out_thread to the CONVERSATION UID (dec-12, ac-23). The
    // server never sees the conversation UID on a raw MCP call (dec-3), so the hook
    // carries it here as thread_uid; this is the join key for "return me to the
    // conversation that worked on this spec". Only updates when this user currently
    // holds the spec, so a stray report can't relabel another holder. Does NOT write
    // presence — checkout is decoupled from the presence plane (dec-5).
    if (actorUserId) {
      await setCheckoutThread({ docId: doc.id, userId: actorUserId, thread: threadUid });
    }

    bumpHookKeyLastUsed(hookKey.id);

    // RECORD-ONLY: a minimal ack, NO steering payload (dec-8).
    return c.json({ recorded: true }, 201);
  });
});

export { specCheckoutRouter };
