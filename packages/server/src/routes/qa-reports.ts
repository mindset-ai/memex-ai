import { Hono } from "hono";
import {
  countUnreadQaReports,
  listQaReports,
  qaReportTagFacets,
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

function parseTimestamp(raw: string | undefined, field: string): Date | undefined {
  if (raw === undefined) return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new ValidationError(`Query param '${field}' must be an ISO-8601 timestamp`);
  }
  return d;
}

// GET /api/<ns>/<mx>/qa-reports — the feed.
//
// Query params (all optional):
//   limit      — page size (default 50, capped 200 by listQaReports)
//   since      — ISO-8601 keyset boundary; returns rows strictly OLDER ("Load More")
//   tag        — tag id; restrict to reports whose owning Spec carries it (spec-286)
//   from / to  — ISO-8601 date window; restrict to reports generated within it
//                (spec-286). tag + (from/to) compose with AND.
qaReports.get("/", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  const limit = parsePositiveInt(c.req.query("limit"), "limit");
  const since = parseTimestamp(c.req.query("since"), "since");
  const tagId = c.req.query("tag") || undefined;
  const from = parseTimestamp(c.req.query("from"), "from");
  const to = parseTimestamp(c.req.query("to"), "to");

  const rows = await listQaReports({ memexId, limit, since, tagId, from, to });

  // Anonymous / non-member projection (the routes/activity.ts convention):
  // actor_*/author_* are PII / display identity — dropped on the public-read path;
  // actorKind, phase, and tags stay so the row is still legible + filterable.
  const accessLevel = c.get("currentAccessLevel");
  if (accessLevel !== "write") {
    return c.json(
      rows.map(
        ({
          actorUserId: _au,
          actorName: _an,
          authorUserId: _ru,
          authorName: _rn,
          ...row
        }) => row,
      ),
    );
  }

  return c.json(rows);
});

// GET /api/<ns>/<mx>/qa-reports/facets — the filter rail's tag tree (spec-286).
// Returns { total, tags: [{ id, scope, value, count }] } over the WHOLE corpus
// (not the loaded page), honouring an optional from/to window so the counts stay
// consistent with an active date filter (AND semantics).
qaReports.get("/facets", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  const from = parseTimestamp(c.req.query("from"), "from");
  const to = parseTimestamp(c.req.query("to"), "to");
  const facets = await qaReportTagFacets({ memexId, from, to });
  return c.json(facets);
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
// (std-7 → 404 otherwise). Returns the PREVIOUS marker too (null on first view)
// — the unread boundary the page uses to render unread rows expanded (ac-24).
qaReports.post("/view", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  const userId = (c.get("currentUserId") as string | null) ?? null;
  if (!userId) throw new NotFoundError("Not found");
  const receipt = await recordQaReportsView(memexId, userId);
  return c.json({
    lastViewedAt: receipt.lastViewedAt.toISOString(),
    previousLastViewedAt: receipt.previousLastViewedAt?.toISOString() ?? null,
  });
});

export { qaReports };
