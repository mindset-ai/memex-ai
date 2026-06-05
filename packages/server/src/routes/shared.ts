import { NotFoundError, ValidationError } from "../types/errors.js";
import type { Memex } from "../db/schema.js";
import { canReadMemex } from "../mcp/auth.js";

// Resource routes (t-9) need a memex context to scope queries. The session
// middleware sets `currentMemexId` after membership verification (see
// middleware/session.ts) — either from the path-resolved memex (per dec-3 of
// doc-15) or from the user's sole memex when there's only one. Routes that
// arrive without a resolved memex 400.
export function requireMemexId(c: {
  get: (k: "currentMemexId") => unknown;
}): string {
  const memexId = c.get("currentMemexId") as string | null;
  if (memexId) return memexId;

  throw new ValidationError(
    "Memex context required: this endpoint must be accessed inside a resolved memex",
  );
}

// spec-111 t-10 — read-gate resolver for PUBLIC-READ content routes (specs,
// decisions, tasks, ACs, comments, activity). These GET handlers run behind the
// PERMISSIVE publicSessionMiddleware, so `currentUserId` may be null and a
// token-bearing non-member arrives with `currentMemexId === null` (the
// permissive middleware deliberately defers the visibility decision to the read
// gate rather than 404-ing on a membership miss).
//
// Resolution order:
//   1. `currentMemexId` is set ⇒ the caller is a member (or a single-membership
//      user); sessionMiddleware/publicSessionMiddleware already proved access.
//      Return it verbatim — NO behaviour change for members.
//   2. Otherwise fall back to the PATH memex (set by memexResolver from the
//      `/<ns>/<mx>/` prefix) and run `canReadMemex(currentUserId, memex.id)`.
//      Public memex ⇒ readable by anyone incl. anonymous; private memex ⇒ 404
//      (std-7, indistinguishable from non-existent — NEVER 401/403).
//   3. No memex context at all (e.g. an anonymous hit on a flat entity-keyed
//      mount with no path prefix) ⇒ 404.
//
// This is READ-ONLY by contract: it must only be called from GET handlers that
// sit behind publicSessionMiddleware. Write handlers keep strict
// sessionMiddleware + requireMemexId, so an anonymous/non-member request can
// never reach a mutation through this helper.
export async function resolveReadableMemexId(c: {
  get: ((k: "currentMemexId") => unknown) &
    ((k: "currentUserId") => unknown) &
    ((k: "memex") => unknown);
}): Promise<string> {
  const memberMemexId = c.get("currentMemexId") as string | null;
  if (memberMemexId) return memberMemexId;

  const pathMemex = c.get("memex") as Memex | null | undefined;
  if (pathMemex) {
    const userId = (c.get("currentUserId") as string | null) ?? null;
    const allowed = await canReadMemex(userId, pathMemex.id).catch(() => false);
    if (allowed) return pathMemex.id;
    // Private memex + anonymous/non-member → 404 (std-7), not 403.
    throw new NotFoundError("Not found");
  }

  // No member context and no path memex — cannot scope a read. 404 (std-7),
  // never the ValidationError 400 of requireMemexId (which would leak that the
  // route exists but lacks context).
  throw new NotFoundError("Not found");
}
