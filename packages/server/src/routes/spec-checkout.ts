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
import { db } from "../db/connection.js";
import { documents } from "../db/schema.js";
import { verifyHookKey, bumpHookKeyLastUsed } from "../services/hook-keys.js";
import { resolveMemexId } from "../services/emission-keys.js";
import { recordCheckoutEdit } from "../services/spec-checkout.js";
import { markPresent } from "../services/presence.js";

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

  // The key only authorises its OWN Memex — mirror the test-events cross-tenant guard.
  const memexId = await resolveMemexId(parsed.namespace, parsed.memexSlug);
  if (!memexId || memexId !== hookKey.memexId) {
    return c.json(
      {
        error: "unauthorized",
        message: "This hook key does not authorise the Memex named in ref.",
      },
      401,
    );
  }

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

  const actorUserId = hookKey.createdByUserId ?? null;
  await recordCheckoutEdit({
    memexId,
    docId: doc.id,
    threadUid: body.thread_uid,
    changedPaths: body.changed_paths as string[],
    commitSha: (body.commit_sha as string | undefined) ?? null,
    branch: (body.branch as string | undefined) ?? null,
    actorUserId,
  });

  // Beat presence keyed on the thread so the holder reads as "working on spec-N
  // now" (dec-5). Silent / out-of-band (std-8). Skipped when the key has no owner.
  if (actorUserId) {
    await markPresent({
      memexId,
      docId: doc.id,
      actorUserId,
      actorKind: "mcp_agent",
      channel: "mcp",
      clientId: body.thread_uid,
    });
  }

  bumpHookKeyLastUsed(hookKey.id);

  // RECORD-ONLY: a minimal ack, NO steering payload (dec-8).
  return c.json({ recorded: true }, 201);
});

export { specCheckoutRouter };
