// spec-458 — live-stats: the global, cross-tenant aggregate feed behind the
// public memex.ai/live page.
//
// Reads ONLY the RLS-excluded tables (activity_log, usage_events, mcp_sessions,
// mcp_tool_calls — drizzle/0090), so every query here is a plain global scan on
// an existing index; no tenant GUC, no bypass role. The response is aggregates
// plus a templated ticker — nothing user-generated (no narrative, no payload,
// no names, no ids) ever crosses this boundary (spec-458 ac-2).
//
// Served from a process-local single-entry TTL cache (the
// scaffold-additions-cache idiom, std-12 no-Redis posture): one query burst per
// instance per TTL window regardless of visitor count (spec-458 ac-7 / dec-10).

import { and, countDistinct, count, desc, gte, inArray, isNotNull, isNull, notExists, notInArray, or, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { activityLog, mcpSessions, mcpToolCalls, usageEvents } from "../db/schema.js";
import { roundCoord } from "./geo.js";

const CACHE_TTL_MS = 15_000;
/** "Right now" = activity within this window (presence-ish without presence's RLS). */
const NOW_WINDOW_MS = 5 * 60_000;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const TICKER_LIMIT = 30;

// dec-1 / dec-2 — the two display knobs are env-tunable on prod without a
// redeploy (the spec-64 relevance-floor pattern). Read at compute time (not
// module load) so a live env edit takes effect within one cache TTL, and so
// tests can stub them.
const DEFAULT_HEADCOUNT_FLOOR = 25;
const DEFAULT_MAP_WINDOW_HOURS = 24;

export function headcountFloor(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.LIVE_HEADCOUNT_FLOOR);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_HEADCOUNT_FLOOR;
}

export function mapWindowHours(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.LIVE_MAP_WINDOW_HOURS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAP_WINDOW_HOURS;
}

export interface LiveTickerEntry {
  /** Pre-templated, type-only sentence — safe by construction. */
  text: string;
  actorKind: "human" | "agent";
  /** Minute-rounded ISO timestamp (ac-7: no precise cadence fingerprinting). */
  at: string;
}

export interface LiveMapPoint {
  lat: number;
  lng: number;
  kind: "human" | "agent";
  /** 0..1 recency weight — 1 = just now, fades toward the window edge. */
  weight: number;
}

export interface LiveStats {
  now: { humans: number; agents: number };
  lastHour: { actors: number; events: number };
  totals: {
    specsCreatedThisWeek: number;
    decisionsResolvedThisWeek: number;
    acsCreatedThisWeek: number;
    toolCallsToday: number;
    eventsToday: number;
  };
  ticker: LiveTickerEntry[];
  points: LiveMapPoint[];
  /** 'header' = real LB-derived coords; 'demo' = dev-synthesised (never prod). */
  geoSource: "header" | "demo" | "none";
  /** The dec-1/dec-2 display knobs, surfaced so the page renders what the server enforces. */
  config: { headcountFloor: number; mapWindowHours: number };
  generatedAt: string;
}

// ── ac-6 exclusions: seed noise + staff tenants ──────────────────────────────
//
// Two RLS-safe filters (no join to the RLS-scoped documents table, which the
// runtime role could not read cross-tenant — std-36):
//   1. SEED NOISE: every provisioning/seed write carries channel='server'
//      (spec-406 ac-26 threads RequestCtx{channel:'server'} through the
//      handhold-demo + default-standards seeders), so activity_log rows from
//      seeding are excluded wholesale — only human/agent-driven work counts.
//   2. STAFF TENANTS: LIVE_EXCLUDED_MEMEX_IDS (comma-separated memex UUIDs,
//      ops-maintained) filters every memex-carrying store. mcp_sessions has no
//      memex column, so a session is excluded when it has an in-window tool
//      call into an excluded memex (conservative). Residual gap, documented:
//      flat-route human telemetry (memex_id NULL) is not attributable.

export function excludedMemexIds(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.LIVE_EXCLUDED_MEMEX_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ── Ticker templating (ac-2) ─────────────────────────────────────────────────
//
// The ONLY path from activity_log to the public response. Input is the two
// enum-ish code literals (entity, action) plus actor_kind; output is a fixed
// sentence. narrative/payload/actor columns are never selected, so a title or
// name cannot leak by construction.

const ENTITY_NOUN: Record<string, string> = {
  document: "a spec",
  section: "a spec section",
  decision: "a decision",
  task: "a task",
  ac: "an acceptance criterion",
  comment: "a comment",
  clause: "a standard clause",
  tag: "a tag",
  memex: "a workspace",
  issue: "an issue",
  skill_file: "a skill",
  doc_assignee: "a spec assignment",
  conversation_message: "a conversation",
  query: "a search",
};

const ACTION_VERB: Record<string, string> = {
  created: "created",
  updated: "updated",
  deleted: "removed",
  status_changed: "moved forward",
  resolved: "resolved",
  viewed: "read",
  searched: "ran",
};

function templateTicker(entity: string, action: string, actorKind: string): string {
  const noun = ENTITY_NOUN[entity] ?? "a piece of work";
  const verb = ACTION_VERB[action] ?? "touched";
  const actor = actorKind === "human" ? "someone" : "an agent";
  return `${actor} just ${verb} ${noun}`;
}

function publicActorKind(actorKind: string): "human" | "agent" {
  return actorKind === "human" ? "human" : "agent";
}

function roundToMinute(d: Date): string {
  const t = new Date(d);
  t.setSeconds(0, 0);
  return t.toISOString();
}

// ── Dev-only demo geo (prototype stand-in for dec-9) ─────────────────────────
//
// The real geo path (GCLB {client_city_lat_long} headers → city-rounded columns
// on mcp_sessions/usage_events, dec-9) needs the LB, which local dev doesn't
// have. Off-LB, dev synthesises a deterministic city per actor hash so the map is
// visually exercisable. HARD-GATED off production: geoSource says 'demo' and the
// page labels it. Never a prod code path (ac-4 honesty).

const DEMO_CITIES: ReadonlyArray<[number, number]> = [
  [51.5, -0.13], [40.71, -74.01], [37.77, -122.42], [47.61, -122.33],
  [43.65, -79.38], [19.43, -99.13], [-23.55, -46.63], [-34.6, -58.38],
  [48.85, 2.35], [52.52, 13.41], [41.39, 2.17], [52.37, 4.9],
  [59.33, 18.07], [50.08, 14.44], [38.72, -9.14], [53.35, -6.26],
  [6.52, 3.38], [-33.92, 18.42], [30.04, 31.24], [-1.29, 36.82],
  [25.2, 55.27], [28.61, 77.21], [12.97, 77.59], [1.35, 103.82],
  [13.76, 100.5], [35.68, 139.69], [37.57, 126.98], [22.32, 114.17],
  [-33.87, 151.21], [-37.81, 144.96], [-41.29, 174.78], [55.75, 37.62],
  [45.42, -75.7], [32.72, -117.16], [51.05, -114.07], [4.71, -74.07],
];

function demoGeoEnabled(): boolean {
  if (process.env.LIVE_DEMO_GEO === "0") return false;
  return process.env.NODE_ENV !== "production" || process.env.LIVE_DEMO_GEO === "1";
}

/** Deterministic small hash → stable city per actor within a session. */
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function demoPoint(seed: string, kind: "human" | "agent", weight: number): LiveMapPoint {
  const h = hashString(seed);
  const [lat, lng] = DEMO_CITIES[h % DEMO_CITIES.length];
  // City-blob jitter (~±0.4°) — mirrors the rounding+jitter posture of ac-3.
  const jLat = ((h >> 8) % 100) / 125 - 0.4;
  const jLng = ((h >> 16) % 100) / 125 - 0.4;
  return { lat: lat + jLat, lng: lng + jLng, kind, weight };
}

// ── The aggregate read ───────────────────────────────────────────────────────

async function computeLiveStats(): Promise<LiveStats> {
  __computeCount++;
  const nowMs = Date.now();
  const floor = headcountFloor();
  const windowHours = mapWindowHours();
  const windowMs = windowHours * HOUR_MS;
  const excluded = excludedMemexIds();
  // and() drops undefined conditions, so these are no-ops when unset.
  const activityNotSeed = sql`${activityLog.channel} <> 'server'`;
  const activityNotExcluded = excluded.length
    ? notInArray(activityLog.memexId, excluded)
    : undefined;
  const usageNotExcluded = excluded.length
    ? or(isNull(usageEvents.memexId), notInArray(usageEvents.memexId, excluded))
    : undefined;
  const callsNotExcluded = excluded.length
    ? or(isNull(mcpToolCalls.memexId), notInArray(mcpToolCalls.memexId, excluded))
    : undefined;
  // A session is excluded when ANY in-window call touched an excluded memex.
  const sessionNotExcluded = excluded.length
    ? notExists(
        db
          .select({ one: sql`1` })
          .from(mcpToolCalls)
          .where(
            and(
              sql`${mcpToolCalls.sessionId} = ${mcpSessions.sessionId}`,
              inArray(mcpToolCalls.memexId, excluded),
            ),
          ),
      )
    : undefined;
  const nowFloor = new Date(nowMs - NOW_WINDOW_MS);
  const hourFloor = new Date(nowMs - HOUR_MS);
  const windowFloor = new Date(nowMs - windowMs);
  const dayFloor = new Date(nowMs - DAY_MS);
  const weekFloor = new Date(nowMs - WEEK_MS);

  const [
    humansNowActivity,
    humansNowUsage,
    agentsNowSessions,
    agentsNowCalls,
    hourActivityActors,
    hourCallActors,
    hourEvents,
    weekSpecs,
    weekDecisionsResolved,
    weekAcs,
    dayCalls,
    dayEvents,
    tickerRows,
    windowActorRows,
    agentGeoRows,
    humanGeoRows,
  ] = await Promise.all([
    db
      .select({ n: countDistinct(activityLog.actorUserId) })
      .from(activityLog)
      .where(
        and(
          gte(activityLog.createdAt, nowFloor),
          sql`${activityLog.actorKind} = 'human'`,
          isNotNull(activityLog.actorUserId),
          activityNotSeed,
          activityNotExcluded,
        ),
      ),
    db
      .select({ n: countDistinct(usageEvents.actorUserId) })
      .from(usageEvents)
      .where(
        and(
          gte(usageEvents.occurredAt, nowFloor),
          isNotNull(usageEvents.actorUserId),
          usageNotExcluded,
        ),
      ),
    db
      .select({ n: countDistinct(mcpSessions.userId) })
      .from(mcpSessions)
      .where(and(gte(mcpSessions.lastSeenAt, nowFloor), sessionNotExcluded)),
    db
      .select({ n: countDistinct(mcpToolCalls.sessionId) })
      .from(mcpToolCalls)
      .where(and(gte(mcpToolCalls.createdAt, nowFloor), callsNotExcluded)),
    db
      .select({ n: countDistinct(activityLog.actorUserId) })
      .from(activityLog)
      .where(
        and(
          gte(activityLog.createdAt, hourFloor),
          isNotNull(activityLog.actorUserId),
          activityNotSeed,
          activityNotExcluded,
        ),
      ),
    db
      .select({ n: countDistinct(mcpToolCalls.userId) })
      .from(mcpToolCalls)
      .where(and(gte(mcpToolCalls.createdAt, hourFloor), callsNotExcluded)),
    db
      .select({ n: count() })
      .from(activityLog)
      .where(and(gte(activityLog.createdAt, hourFloor), activityNotSeed, activityNotExcluded)),
    db
      .select({ n: count() })
      .from(activityLog)
      .where(
        and(
          gte(activityLog.createdAt, weekFloor),
          sql`${activityLog.entity} = 'document'`,
          sql`${activityLog.action} = 'created'`,
          activityNotSeed,
          activityNotExcluded,
        ),
      ),
    // dec-3: decisions RESOLVED — an outcome, not touches.
    db
      .select({ n: count() })
      .from(activityLog)
      .where(
        and(
          gte(activityLog.createdAt, weekFloor),
          sql`${activityLog.entity} = 'decision'`,
          sql`${activityLog.action} = 'resolved'`,
          activityNotSeed,
          activityNotExcluded,
        ),
      ),
    db
      .select({ n: count() })
      .from(activityLog)
      .where(
        and(
          gte(activityLog.createdAt, weekFloor),
          sql`${activityLog.entity} = 'ac'`,
          sql`${activityLog.action} = 'created'`,
          activityNotSeed,
          activityNotExcluded,
        ),
      ),
    db
      .select({ n: count() })
      .from(mcpToolCalls)
      .where(and(gte(mcpToolCalls.createdAt, dayFloor), callsNotExcluded)),
    db
      .select({ n: count() })
      .from(activityLog)
      .where(and(gte(activityLog.createdAt, dayFloor), activityNotSeed, activityNotExcluded)),
    // Ticker: enum-ish columns ONLY — never narrative/payload/actor columns (ac-2).
    db
      .select({
        entity: activityLog.entity,
        action: activityLog.action,
        actorKind: activityLog.actorKind,
        createdAt: activityLog.createdAt,
      })
      .from(activityLog)
      .where(and(activityNotSeed, activityNotExcluded))
      .orderBy(sql`${activityLog.createdAt} DESC`)
      .limit(TICKER_LIMIT),
    // Map points source (dec-2/dec-8): windowed recent actors (hashed ids never
    // leave the server — they only seed the demo-city pick below).
    db
      .select({
        actorUserId: activityLog.actorUserId,
        actorKind: activityLog.actorKind,
        createdAt: activityLog.createdAt,
      })
      .from(activityLog)
      .where(
        and(
          gte(activityLog.createdAt, windowFloor),
          isNotNull(activityLog.actorUserId),
          activityNotSeed,
          activityNotExcluded,
        ),
      )
      .orderBy(sql`${activityLog.createdAt} DESC`)
      .limit(200),
    // Real geo, agents (dec-9): sessions with LB-derived coords, in-window.
    // userId is selected ONLY to dedupe per actor below — it never leaves.
    db
      .select({
        userId: mcpSessions.userId,
        lat: mcpSessions.geoLat,
        lng: mcpSessions.geoLng,
        at: mcpSessions.lastSeenAt,
      })
      .from(mcpSessions)
      .where(
        and(
          gte(mcpSessions.lastSeenAt, windowFloor),
          isNotNull(mcpSessions.geoLat),
          sessionNotExcluded,
        ),
      )
      .orderBy(desc(mcpSessions.lastSeenAt))
      .limit(120),
    // Real geo, humans (dec-9): latest located usage event per actor, in-window.
    db
      .selectDistinctOn([usageEvents.actorUserId], {
        userId: usageEvents.actorUserId,
        lat: usageEvents.geoLat,
        lng: usageEvents.geoLng,
        at: usageEvents.occurredAt,
      })
      .from(usageEvents)
      .where(
        and(
          gte(usageEvents.occurredAt, windowFloor),
          isNotNull(usageEvents.geoLat),
          isNotNull(usageEvents.actorUserId),
          usageNotExcluded,
        ),
      )
      .orderBy(usageEvents.actorUserId, desc(usageEvents.occurredAt))
      .limit(120),
  ]);

  const humansNow = Math.max(humansNowActivity[0]?.n ?? 0, humansNowUsage[0]?.n ?? 0);
  const agentsNow = Math.max(agentsNowSessions[0]?.n ?? 0, agentsNowCalls[0]?.n ?? 0);

  const ticker: LiveTickerEntry[] = tickerRows.map((r) => ({
    text: templateTicker(r.entity, r.action, r.actorKind),
    actorKind: publicActorKind(r.actorKind),
    at: roundToMinute(r.createdAt),
  }));

  // Points (dec-8/dec-9): real LB-derived coords when any exist; the dev-only
  // synthesised fallback otherwise. Real coords are already city-rounded at
  // write; the public response jitters them AGAIN (ac-3/ac-15) so a repeated
  // poll can't triangulate the stored value. Dedupe per actor+kind (ac-19);
  // ids seed the jitter hash and never leave the server.
  const points: LiveMapPoint[] = [];
  let geoSource: LiveStats["geoSource"] = "none";
  const realRows = [
    ...agentGeoRows.map((r) => ({ ...r, kind: "agent" as const })),
    ...humanGeoRows.map((r) => ({ ...r, kind: "human" as const })),
  ];
  if (realRows.length > 0) {
    geoSource = "header";
    const seen = new Set<string>();
    for (const row of realRows) {
      if (row.lat == null || row.lng == null || row.at == null) continue;
      const key = `${row.userId}:${row.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const age = nowMs - row.at.getTime();
      const weight = Math.max(0.15, 1 - age / windowMs);
      const h = hashString(key);
      // Read-side jitter: 0.03–0.13° magnitude (never zero — the response value
      // must never equal the stored one), sign from the hash, deterministic per
      // actor within a session so dots don't dance between polls.
      const jLat = (0.03 + (h % 100) / 1000) * ((h >> 4) % 2 === 0 ? 1 : -1);
      const jLng = (0.03 + ((h >> 8) % 100) / 1000) * ((h >> 12) % 2 === 0 ? 1 : -1);
      points.push({
        lat: Number((roundCoord(row.lat) + jLat).toFixed(3)),
        lng: Number((roundCoord(row.lng) + jLng).toFixed(3)),
        kind: row.kind,
        weight: Number(weight.toFixed(2)),
      });
      if (points.length >= 80) break;
    }
  } else if (demoGeoEnabled()) {
    geoSource = "demo";
    const seen = new Set<string>();
    for (const row of windowActorRows) {
      const kind = publicActorKind(row.actorKind);
      const key = `${row.actorUserId}:${kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const age = nowMs - row.createdAt.getTime();
      const weight = Math.max(0.15, 1 - age / windowMs);
      points.push(demoPoint(key, kind, Number(weight.toFixed(2))));
      if (points.length >= 80) break;
    }
  }

  return {
    now: { humans: humansNow, agents: agentsNow },
    lastHour: {
      actors: Math.max(hourActivityActors[0]?.n ?? 0, hourCallActors[0]?.n ?? 0),
      events: hourEvents[0]?.n ?? 0,
    },
    totals: {
      specsCreatedThisWeek: weekSpecs[0]?.n ?? 0,
      decisionsResolvedThisWeek: weekDecisionsResolved[0]?.n ?? 0,
      acsCreatedThisWeek: weekAcs[0]?.n ?? 0,
      toolCallsToday: dayCalls[0]?.n ?? 0,
      eventsToday: dayEvents[0]?.n ?? 0,
    },
    ticker,
    points,
    geoSource,
    config: { headcountFloor: floor, mapWindowHours: windowHours },
    generatedAt: roundToMinute(new Date(nowMs)),
  };
}

// ── TTL cache (single global key) ────────────────────────────────────────────

let cached: { value: LiveStats; expiresAt: number } | null = null;
let inFlight: Promise<LiveStats> | null = null;

// Test instrumentation (the scaffold-additions-cache pattern): counts underlying
// DB-touching computes so coalescing/TTL tests can assert "only one burst
// happened" without spying. Test-only — production code never reads this.
let __computeCount = 0;
export function __liveStatsComputeCount(): number {
  return __computeCount;
}

export async function getLiveStats(): Promise<LiveStats> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;
  // Coalesce concurrent misses onto one DB burst.
  if (!inFlight) {
    inFlight = computeLiveStats()
      .then((value) => {
        cached = { value, expiresAt: Date.now() + CACHE_TTL_MS };
        return value;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/** Test seam. */
export function __resetLiveStatsCache(): void {
  cached = null;
  inFlight = null;
}
