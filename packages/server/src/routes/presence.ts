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
import { markPresent, listPresent } from "../services/presence.js";
import { parseRef } from "./../services/refs.js";
import { ValidationError } from "../types/errors.js";
import { actorName } from "../services/actor.js";
import {
  sessionMiddleware,
  publicSessionMiddleware,
  type SessionEnv,
} from "../middleware/session.js";
import type { MemexResolverEnv } from "../middleware/memex-resolver.js";
import { requireMemexId, resolveReadableMemexId } from "./shared.js";

type Env = MemexResolverEnv & SessionEnv;
const presenceRouter = new Hono<Env>();

// GET (read who's here) is public-read like the rest of the spec surface; the
// POST heartbeat is a write and stays strict (only an authenticated member can
// declare presence).
presenceRouter.on("GET", "/*", publicSessionMiddleware);
presenceRouter.on(["POST", "PUT", "PATCH", "DELETE"], "/*", sessionMiddleware);

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

// GET /api/<ns>/<mx>/presence?ref=<spec> — who's "here" in a spec, for the UI.
presenceRouter.get("/", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  const ref = c.req.query("ref")?.trim();
  if (!ref) throw new ValidationError("presence read requires a 'ref' query param");

  const spec = await getDoc(memexId, specHandleFromRef(ref));
  const rows = await listPresent(memexId, spec.id);
  return c.json(rows);
});

export { presenceRouter };
