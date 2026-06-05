import { Hono } from "hono";
import { listActivity } from "../services/activity-log.js";
import { getDoc } from "../services/documents.js";
import { ValidationError } from "../types/errors.js";
import {
  sessionMiddleware,
  publicSessionMiddleware,
  type SessionEnv,
} from "../middleware/session.js";
import type { MemexResolverEnv } from "../middleware/memex-resolver.js";
import { resolveReadableMemexId } from "./shared.js";

// ── Pulse history (b-60, t-12) ────────────────────────────────────────────────
//
// GET /api/<ns>/<mx>/activity — the chronological timeline the Pulse dashboard
// renders. Backed by `listActivity` over the immutable `activity_log` table
// (newest-first, keyset paginated via `since`).
//
// Tenancy: `requireMemexId(c)` returns the memexId that memexResolver +
// sessionMiddleware already resolved from the `/api/<ns>/<mx>/` path prefix and
// the caller's verified membership. A caller hitting another tenant's path is
// rejected upstream (memexResolver 404s an unknown namespace/memex; session
// middleware rejects a non-member) — so by the time a handler runs, the
// memexId is one the caller is authorized for and every query is scoped to it.
// Per std-7 cross-tenant access surfaces as 404, never 403.

type Env = MemexResolverEnv & SessionEnv;
const activity = new Hono<Env>();

// spec-111 t-10 — the Pulse timeline is part of the public-Memex view, so the
// GET read goes behind the permissive session (public read / private 404 via
// resolveReadableMemexId). Mutating verbs (there are none today) stay strict so
// any future write can never be reached anonymously.
activity.on("GET", "/*", publicSessionMiddleware);
activity.on(["POST", "PUT", "PATCH", "DELETE"], "/*", sessionMiddleware);

// Parse a positive-integer query param. Returns undefined when absent; throws a
// 400 on a present-but-unparseable value so callers learn about a typo instead
// of silently getting the default. listActivity itself floors + caps `limit`
// (default 50, max 200), so we only validate shape here.
function parsePositiveInt(raw: string | undefined, field: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new ValidationError(`Query param '${field}' must be a positive integer`);
  }
  return n;
}

// Parse the `since` keyset boundary — an ISO-8601 timestamp (the `createdAt` of
// the previous page's last row). Absent → undefined; present-but-invalid → 400.
function parseSince(raw: string | undefined): Date | undefined {
  if (raw === undefined) return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new ValidationError("Query param 'since' must be an ISO-8601 timestamp");
  }
  return d;
}

// GET /api/<ns>/<mx>/activity — Pulse timeline for the resolved Memex.
//
// Query params (all optional):
//   limit        — page size (default 50, capped 200 by listActivity)
//   since        — ISO-8601 keyset boundary; returns rows strictly OLDER ("load older")
//   actorUserId  — filter to one human actor (UUID)
//   clientId     — filter to one originating client (opaque string)
//   briefId      — filter to activity touching one Spec; accepts a `spec-N` /
//                  legacy `b-N` handle OR a UUID (resolved to the canonical id
//                  below). The `briefId` query-param name is wire-format
//                  preserved under the b-105 allowlist.
activity.get("/", async (c) => {
  const memexId = await resolveReadableMemexId(c);

  const limit = parsePositiveInt(c.req.query("limit"), "limit");
  const since = parseSince(c.req.query("since"));
  const actorUserId = c.req.query("actorUserId") || undefined;
  const clientId = c.req.query("clientId") || undefined;

  // `briefId` mirrors the ref convention the other routes accept: a `spec-N` /
  // legacy `b-N` handle (what users type) or the canonical UUID.
  // getDoc(memexId, idOrHandle) resolves either form scoped to this Memex and
  // throws NotFoundError (→ 404) when the Spec doesn't exist OR belongs to
  // another tenant — the same 404-not-403 cross-tenant guard the rest of the
  // doc surface uses (std-7). activity_log.brief_id stores the canonical id,
  // so we filter on the resolved id rather than the raw handle.
  const briefRef = c.req.query("briefId") || undefined;
  let briefId: string | undefined;
  if (briefRef !== undefined) {
    const spec = await getDoc(memexId, briefRef);
    briefId = spec.id;
  }

  const rows = await listActivity({
    memexId,
    limit,
    since,
    actorUserId,
    clientId,
    briefId,
  });

  return c.json(rows);
});

export { activity };
