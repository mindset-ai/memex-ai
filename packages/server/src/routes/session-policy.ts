// spec-377 (spec-355 dry-10) — the standard per-verb session policy, extracted.
//
// Almost every tenant-scoped resource router wires the SAME two lines: GET reads
// run behind the PERMISSIVE publicSessionMiddleware (public read / private 404 via
// the read gate, e.g. resolveReadableMemexId), and every mutating verb stays STRICT
// behind sessionMiddleware so a non-member can never reach a write. That ordering is
// exactly what produces std-7's 404-not-403 unauthorized posture, so it must be
// applied identically everywhere.
//
// This helper is the single source of that wiring. It is generic over any Env that
// includes SessionEnv, so each router keeps its own precise Hono<Env> type.
//
// NOT for every router: routers that genuinely deviate (e.g. a GET-only read router
// with no mutating verbs, like search.ts) keep their own bespoke wiring — never
// flatten a real difference into this helper.

import type { Hono } from "hono";
import {
  sessionMiddleware,
  publicSessionMiddleware,
  type SessionEnv,
} from "../middleware/session.js";

export function mountStandardSessionPolicy<E extends SessionEnv>(
  router: Hono<E>,
): Hono<E> {
  router.on("GET", "/*", publicSessionMiddleware);
  router.on(["POST", "PUT", "PATCH", "DELETE"], "/*", sessionMiddleware);
  return router;
}
