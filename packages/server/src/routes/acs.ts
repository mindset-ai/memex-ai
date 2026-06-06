// HTTP routes for the AC tab in the React UI.
//
// Tenant-scoped (mounted under /api/:namespace/:memex/acs in app.ts). All
// routes resolve the active memex from sessionMiddleware + memexResolver and
// then defer to services/acs.ts for the actual queries.
//
// Endpoints:
//   GET    /doc/:docId                   — snapshot of every AC + its tests +
//                                          derived verification_state. Powers
//                                          the main tab content; polled every
//                                          ~3s by the React tab while visible.
//   GET    /doc/:docId/alignment-history — daily verified/total counts per
//                                          kind for the last `?days=N` days
//                                          (default 30). Powers the sparkline
//                                          at the top of each section.
//   GET    /:acId/test-matrix            — per-AC test event matrix (b-96):
//                                          every distinct `test_identifier`
//                                          ever recorded with its full
//                                          emission timeline.
//   DELETE /:acId/test-events            — hard-delete every emission for
//                                          `(acUid, test_identifier)` query
//                                          param (b-96 discontinue flow).
//   POST   /:acId/acceptance             — record a manual verification
//                                          acceptance (spec-188): the audited
//                                          human override for ACs that can't
//                                          be exercised by a digital test.
//   DELETE /:acId/acceptance             — revoke the acceptance, restoring
//                                          the test-derived state.
//
// Per std-7, non-member callers get NotFoundError → 404 from the underlying
// service tenancy check; no 401/403 leak.

import { Hono } from "hono";
import {
  listAcsForBriefWithVerification,
  listAcAlignmentOverTime,
  listTestMatrixForAc,
  discontinueTestEventsForAc,
  setAcAcceptance,
  clearAcAcceptance,
} from "../services/acs.js";
import {
  sessionMiddleware,
  publicSessionMiddleware,
  type SessionEnv,
} from "../middleware/session.js";
import type { MemexResolverEnv } from "../middleware/memex-resolver.js";
import { requireMemexId, resolveReadableMemexId } from "./shared.js";

type Env = MemexResolverEnv & SessionEnv;

const acsRouter = new Hono<Env>();
// spec-111 t-10 — per-verb session policy. GET reads permissive (public read /
// private 404 via resolveReadableMemexId); the DELETE write stays strict.
acsRouter.on("GET", "/*", publicSessionMiddleware);
acsRouter.on(["POST", "PUT", "PATCH", "DELETE"], "/*", sessionMiddleware);

acsRouter.get("/doc/:docId", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  const docId = c.req.param("docId");
  const rows = await listAcsForBriefWithVerification(memexId, docId);
  return c.json(rows);
});

acsRouter.get("/doc/:docId/alignment-history", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  const docId = c.req.param("docId");
  // Parse + clamp `?days=` so a misbehaving client can't ask for 9000.
  // 7..90 covers spike use cases; the sparkline is a phase-1 affordance and
  // doesn't need to span quarters.
  const rawDays = Number(c.req.query("days") ?? "30");
  const days = Number.isFinite(rawDays)
    ? Math.max(7, Math.min(90, Math.floor(rawDays)))
    : 30;
  const rows = await listAcAlignmentOverTime(memexId, docId, days);
  return c.json(rows);
});

acsRouter.get("/:acId/test-matrix", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  const acId = c.req.param("acId");
  const rows = await listTestMatrixForAc(memexId, acId);
  return c.json(rows);
});

// spec-188: manual verification acceptance. Strict sessionMiddleware applies
// (write verb), so c.get("user") is always set here. Actor is a display
// snapshot — name when present, else email — same posture as test_events.actor.
acsRouter.post("/:acId/acceptance", async (c) => {
  const memexId = requireMemexId(c);
  const acId = c.req.param("acId");
  const user = c.get("user");
  const actor = user?.name?.trim() || user?.email || "";
  const result = await setAcAcceptance(memexId, acId, actor);
  return c.json(result);
});

acsRouter.delete("/:acId/acceptance", async (c) => {
  const memexId = requireMemexId(c);
  const acId = c.req.param("acId");
  const result = await clearAcAcceptance(memexId, acId);
  return c.json(result);
});

acsRouter.delete("/:acId/test-events", async (c) => {
  const memexId = requireMemexId(c);
  const acId = c.req.param("acId");
  const testIdentifier = c.req.query("test_identifier");
  if (typeof testIdentifier !== "string" || testIdentifier.length === 0) {
    return c.json({ error: "test_identifier query parameter is required" }, 400);
  }
  const result = await discontinueTestEventsForAc(memexId, acId, testIdentifier);
  return c.json(result);
});

export { acsRouter };
