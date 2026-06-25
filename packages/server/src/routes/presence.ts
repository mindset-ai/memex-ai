// spec-122 t-7 (dec-4, ac-16) — the BROWSER HEARTBEAT endpoint.
//
// The React UI pings POST .../presence every ~15s while its tab is visible to
// say "I'm here, on this spec, right now". The payload carries ONLY the spec
// ref (+ optionally an opaque per-tab client id) — NEVER any document content;
// the timestamp is stamped server-side as now(). GET reads who's "here" in a
// spec for the UI.
//
// Tenancy: the memexId is resolved by memexResolver + sessionMiddleware from the
// /api/<ns>/<mx>/ path prefix (requireMemexId). The spec ref in the body is
// resolved to a doc id via getDoc scoped to that memex — a cross-tenant ref 404s
// (std-7). Writes flow through markPresent(), which is SILENT/out-of-band per
// std-8 (a heartbeat is not an activity line — ac-17).

import { Hono } from "hono";
import { getDoc } from "../services/documents.js";
import { markPresent, listPresent, listPresentForMemex } from "../services/presence.js";
import { parseRef } from "./../services/refs.js";
import { ValidationError } from "../types/errors.js";
import { actorName } from "../services/actor.js";
import { type SessionEnv } from "../middleware/session.js";
import type { MemexResolverEnv } from "../middleware/memex-resolver.js";
import { requireMemexId, resolveReadableMemexId } from "./shared.js";
import { mountStandardSessionPolicy } from "./session-policy.js";

type Env = MemexResolverEnv & SessionEnv;
const presenceRouter = new Hono<Env>();

// GET (read who's here) is public-read like the rest of the spec surface; the
// POST heartbeat is a write and stays strict (only an authenticated member can
// declare presence). spec-377 — the standard policy (see session-policy.ts).
mountStandardSessionPolicy(presenceRouter);

// Accept either a full canonical ref ("<ns>/<mx>/specs/spec-N") or a bare
// "spec-N" handle. getDoc resolves either form scoped to the memex.
function specHandleFromRef(ref: string): string {
  const parsed = parseRef(ref);
  if (parsed.ok) {
    if (parsed.ref.docType !== "specs") {
      throw new ValidationError("presence ref must point at a spec");
    }
    return parsed.ref.docHandle;
  }
  // Not a full canonical ref — accept a bare handle / UUID and let getDoc decide.
  return ref;
}

// POST /api/<ns>/<mx>/presence — the browser heartbeat. Body: { ref } (+ optional
// { clientId }). The timestamp is now(); no document content is accepted.
presenceRouter.post("/", async (c) => {
  const memexId = requireMemexId(c);
  const user = c.get("user");

  const body: { ref?: unknown; clientId?: unknown } = await c.req
    .json<{ ref?: unknown; clientId?: unknown }>()
    .catch(() => ({}));
  const ref = typeof body.ref === "string" ? body.ref.trim() : "";
  if (ref === "") throw new ValidationError("presence requires a 'ref'");
  const clientId = typeof body.clientId === "string" ? body.clientId : "";

  const spec = await getDoc(memexId, specHandleFromRef(ref));

  await markPresent({
    memexId,
    docId: spec.id,
    actorUserId: user.id,
    actorName: actorName(user),
    actorKind: "human",
    channel: "rest_ui",
    clientId,
  });

  return c.json({ ok: true });
});

// GET /api/<ns>/<mx>/presence — who's "here", for the UI.
//   • no `ref`        → whole-workspace presence in ONE indexed read (spec-407
//     dec-1, option A). The Pulse "Working now" zone calls this once per poll
//     instead of fanning out one request per spec — listPresentForMemex returns
//     the table rows (within TTL) UNIONed with the passive floor, merged.
//   • `?ref=<spec>`   → presence for a single spec (the ambient indicator).
// Both forms stay behind mountStandardSessionPolicy, so tenant resolution + RLS
// scoping (std-36) are identical: the whole-workspace read returns ONLY the
// caller's Memex (tableRowsForMemex filters by memexId, RLS enforces it). No
// multi-ref `?refs=a,b,c` shape — the only fan-out caller wants the whole
// workspace, so it would be API surface with no consumer (spec-407 dec-1).
presenceRouter.get("/", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  const ref = c.req.query("ref")?.trim();

  if (!ref) {
    const rows = await listPresentForMemex(memexId);
    return c.json(rows);
  }

  const spec = await getDoc(memexId, specHandleFromRef(ref));
  const rows = await listPresent(memexId, spec.id);
  return c.json(rows);
});

export { presenceRouter };
