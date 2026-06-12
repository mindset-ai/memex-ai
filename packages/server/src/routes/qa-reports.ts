import { Hono } from "hono";
import {
  countUnreadQaReports,
  listQaReports,
  recordQaReportsView,
} from "../services/qa-reports.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import {
  sessionMiddleware,
  publicSessionMiddleware,
  type SessionEnv,
} from "../middleware/session.js";
import type { MemexResolverEnv } from "../middleware/memex-resolver.js";
import { resolveReadableMemexId } from "./shared.js";

// ── QA Reports feed + unread counter (spec-260 dec-5 / dec-6) ─────────────────
//
// GET  /api/<ns>/<mx>/qa-reports          — cross-Spec feed, newest-first, keyset
//                                           `since` pagination (the Pulse pattern).
// GET  /api/<ns>/<mx>/qa-reports/unread   — the caller's per-user unread count.
// POST /api/<ns>/<mx>/qa-reports/view     — record "viewed now": upserts the
//                                           (user, memex) last_viewed_at marker,
//                                           zeroing the badge.
//
// Tenancy mirrors routes/activity.ts: reads ride the permissive session (public
// read / private 404 via resolveReadableMemexId, std-7); the mutating view-marker
// verb stays strict. The per-user marker itself is additionally guarded by the
// qa_report_views RLS policy (migration 0092).

type Env = MemexResolverEnv & SessionEnv;
const qaReports = new Hono<Env>();

qaReports.on("GET", "/*", publicSessionMiddleware);
qaReports.on(["POST", "PUT", "PATCH", "DELETE"], "/*", sessionMiddleware);

// Same shape-validators as routes/activity.ts — present-but-invalid params 400
// rather than silently defaulting.
function parsePositiveInt(raw: string | undefined, field: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new ValidationError(`Query param '${field}' must be a positive integer`);
  }
  return n;
}

function parseSince(raw: string | undefined): Date | undefined {
  if (raw === undefined) return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new ValidationError("Query param 'since' must be an ISO-8601 timestamp");
  }
  return d;
}

// GET /api/<ns>/<mx>/qa-reports — the feed.
//
// Query params (both optional):
//   limit — page size (default 50, capped 200 by listQaReports)
//   since — ISO-8601 keyset boundary; returns rows strictly OLDER ("Load More")
qaReports.get("/", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  const limit = parsePositiveInt(c.req.query("limit"), "limit");
  const since = parseSince(c.req.query("since"));

  const rows = await listQaReports({ memexId, limit, since });

  // Anonymous / non-member projection (the routes/activity.ts convention):
  // actor_user_id is PII and actor_name a display identity — both are dropped
  // on the public-read path; actorKind keeps the row legible.
  const accessLevel = c.get("currentAccessLevel");
  if (accessLevel !== "write") {
    return c.json(
      rows.map(({ actorUserId: _u, actorName: _n, ...row }) => row),
    );
  }

  return c.json(rows);
});

// GET /api/<ns>/<mx>/qa-reports/unread — the caller's unread count. Per-user by
// definition, so an anonymous reader has no badge: count 0, not an error.
qaReports.get("/unread", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  const userId = (c.get("currentUserId") as string | null) ?? null;
  if (!userId) return c.json({ count: 0 });
  const count = await countUnreadQaReports(memexId, userId);
  return c.json({ count });
});

// POST /api/<ns>/<mx>/qa-reports/view — "I viewed the feed now". Strict session
// (anonymous callers never reach here); the memex must be readable by the caller
// (std-7 → 404 otherwise).
qaReports.post("/view", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  const userId = (c.get("currentUserId") as string | null) ?? null;
  if (!userId) throw new NotFoundError("Not found");
  const lastViewedAt = await recordQaReportsView(memexId, userId);
  return c.json({ lastViewedAt: lastViewedAt.toISOString() });
});

export { qaReports };
