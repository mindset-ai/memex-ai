// spec-315 iteration 2 (dec-2) — "Your specs" on Home: ownership-tiered, cross-Memex,
// rendered with Pulse's HotSpecCard. A spec qualifies if it is assigned to me OR created
// by me OR I have acted on it, within the last 90 days, demo specs INCLUDED. Two tiers,
// each sorted by MY last activity (desc): tier 1 = assigned, tier 2 = created/acted.
//
// The server computes everything the reused card needs (phase, latest narrative, AC
// health, a recent-activity spark, involved actors) so the client just renders. Same
// membership-iteration + per-Memex RLS posture as the rest of Home (t-1); tenancy is
// structural.

import { and, eq, inArray, sql } from "drizzle-orm";
import { db, runWithMemexId } from "../db/connection.js";
import { docAssignees, documents } from "../db/schema.js";
import { listMemberships } from "./users.js";
import { aggregateAcHealthForBriefs } from "./acs.js";
import type { AcHealth } from "../types/index.js";

const WINDOW_DAYS = 90;
const SPARK_DAYS = 14; // the spark + involved + narrative are drawn from recent activity only
const MAX_INVOLVED = 5;

// spec-353 (perf-2) — the cross-Memex fan-out runs each member Memex's block in
// its OWN runWithMemexId ALS subtree, so we can race them with Promise.all
// without crossing tenant streams (each subtree sets its own app.memex_id GUC at
// every query call — std-36). Bounded so we never exceed the postgres-js pool
// (DB_POOL_MAX, default 5): each per-Memex block holds a connection only for the
// duration of its RLS micro-transactions, so a batch of MEMEX_CONCURRENCY blocks
// stays inside the pool while still collapsing N serial round-trips into ⌈N/4⌉.
const MEMEX_CONCURRENCY = 4;

export interface HomeWorker {
  actorUserId: string | null;
  actorName: string | null;
  actorKind: string;
  lastSeenMs: number;
}

export interface HomeSpecCard {
  docId: string;
  handle: string;
  title: string;
  phase: string; // documents.status — "draft" | "specify" | "build" | "verify" | "done"
  narrative: string | null; // latest activity narrative on the spec
  health: AcHealth | null;
  spark: number[]; // per-day event counts over the last SPARK_DAYS (oldest → newest)
  involved: HomeWorker[]; // recent distinct actors (for avatars)
  lastActivityMineMs: number | null; // MY last activity — the ordering key + card age/state input
  lastActivityAnyMs: number | null; // anyone's last activity — drives the card's active/cooling state
  tier: "assigned" | "mine";
  memexId: string;
  namespaceSlug: string;
  memexSlug: string;
  memexName: string;
  path: string; // /<ns>/<memex>/specs/<handle>
}

interface MemexProvenance {
  namespaceSlug: string;
  memexSlug: string;
  memexName: string;
}

interface RecentRow {
  docId: string;
  at: Date | string;
  actorUserId: string | null;
  actorName: string | null;
  channel: string | null;
  narrative: string | null;
}

// activity_view carries `channel` (HOW), not actor_kind — derive a coarse kind for the avatar.
function kindFromChannel(channel: string | null): string {
  if (channel === "mcp") return "mcp_agent";
  if (channel === "in_app_agent") return "in_app_agent";
  if (channel === "server") return "system";
  return "human";
}

const ms = (d: Date | string): number => (d instanceof Date ? d : new Date(d)).getTime();

function inList(ids: readonly string[]) {
  return sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
}

function perDayCounts(rows: readonly RecentRow[], days: number, now: number): number[] {
  const buckets = new Array<number>(days).fill(0);
  const dayMs = 86_400_000;
  for (const r of rows) {
    const age = now - ms(r.at);
    if (age < 0) continue;
    const idx = days - 1 - Math.floor(age / dayMs);
    if (idx >= 0 && idx < days) buckets[idx] += 1;
  }
  return buckets;
}

function distinctActors(rows: readonly RecentRow[]): HomeWorker[] {
  const byActor = new Map<string, HomeWorker>();
  for (const r of rows) {
    const kind = kindFromChannel(r.channel);
    const key = `${r.actorUserId ?? "?"}:${kind}`;
    if (byActor.has(key)) continue; // rows are newest-first, so first wins
    byActor.set(key, {
      actorUserId: r.actorUserId,
      actorName: r.actorName,
      actorKind: kind,
      lastSeenMs: ms(r.at),
    });
  }
  return [...byActor.values()].slice(0, MAX_INVOLVED);
}

export async function listHomeSpecs(userId: string): Promise<HomeSpecCard[]> {
  const provByMemex = new Map<string, MemexProvenance>();
  for (const m of await listMemberships(userId)) {
    if (m.source === "visited") continue;
    if (!provByMemex.has(m.memexId)) {
      provByMemex.set(m.memexId, {
        namespaceSlug: m.slug,
        memexSlug: m.memexSlug,
        memexName: m.memexName,
      });
    }
  }

  const now = Date.now();
  const windowSince = new Date(now - WINDOW_DAYS * 86_400_000);
  const sparkSince = new Date(now - SPARK_DAYS * 86_400_000);
  // The RLS micro-transaction wrapper binds params via postgres.unsafe(), which can't
  // serialize a Date — pass ISO text and cast to timestamptz.
  const windowIso = windowSince.toISOString();
  const sparkIso = sparkSince.toISOString();
  const all: HomeSpecCard[] = [];

  // The per-Memex block — RLS-scoped to one tenant via runWithMemexId. Lifted out
  // of the loop so the cross-Memex fan-out can run these in bounded-parallel
  // batches (spec-353). The body is byte-identical to the prior inline loop.
  const loadMemexCards = (memexId: string, prov: MemexProvenance): Promise<HomeSpecCard[]> =>
    runWithMemexId(memexId, async () => {
      // assigned to me (spec-level assignment, spec-118)
      const assignedRows = await db
        .select({ docId: docAssignees.docId, at: docAssignees.assignedAt })
        .from(docAssignees)
        .where(and(eq(docAssignees.userId, userId), eq(docAssignees.memexId, memexId)));
      const assignedAt = new Map(
        assignedRows.filter((r) => ms(r.at) >= windowSince.getTime()).map((r) => [r.docId, ms(r.at)]),
      );

      // my last activity per spec (acted-on), within the window
      const mineRows = (await db.execute(sql`
        SELECT spec_ref AS "docId", MAX(at) AS "at"
        FROM activity_view
        WHERE actor_user_id = ${userId} AND spec_ref IS NOT NULL
          AND memex_id = ${memexId} AND at >= ${windowIso}::timestamptz
        GROUP BY spec_ref
      `)) as unknown as Array<{ docId: string; at: Date | string }>;
      const mineLast = new Map(mineRows.map((r) => [r.docId, ms(r.at)]));

      // created by me, within the window
      const createdRows = await db
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.createdByUserId, userId),
            eq(documents.memexId, memexId),
            eq(documents.docType, "spec"),
            sql`${documents.createdAt} >= ${windowIso}::timestamptz`,
          ),
        );
      const createdIds = new Set(createdRows.map((r) => r.id));

      const qualifying = new Set<string>([...assignedAt.keys(), ...mineLast.keys(), ...createdIds]);
      if (qualifying.size === 0) return [];

      // resolve to SPEC docs only (assigned/acted could reference a non-spec doc)
      const docs = await db
        .select({
          id: documents.id,
          handle: documents.handle,
          title: documents.title,
          status: documents.status,
          docType: documents.docType,
        })
        .from(documents)
        .where(inArray(documents.id, [...qualifying]));
      const docById = new Map(docs.filter((d) => d.docType === "spec").map((d) => [d.id, d]));
      const specIds = [...docById.keys()];
      if (specIds.length === 0) return [];

      const health = await aggregateAcHealthForBriefs(memexId, specIds);

      // recent activity (last SPARK_DAYS) for narrative / involved / spark / last-any
      const recent = (await db.execute(sql`
        SELECT spec_ref AS "docId", at, actor_user_id AS "actorUserId",
               actor_name AS "actorName", channel, narrative
        FROM activity_view
        WHERE memex_id = ${memexId} AND spec_ref IN (${inList(specIds)}) AND at >= ${sparkIso}::timestamptz
        ORDER BY at DESC
        LIMIT 1000
      `)) as unknown as RecentRow[];
      const recentBySpec = new Map<string, RecentRow[]>();
      for (const r of recent) {
        const list = recentBySpec.get(r.docId) ?? [];
        list.push(r);
        recentBySpec.set(r.docId, list);
      }

      return specIds.map((docId): HomeSpecCard => {
        const d = docById.get(docId)!;
        const rows = recentBySpec.get(docId) ?? [];
        const mineMs = mineLast.get(docId) ?? assignedAt.get(docId) ?? null;
        return {
          docId,
          handle: d.handle,
          title: d.title,
          phase: d.status,
          narrative: rows.find((r) => r.narrative)?.narrative ?? null,
          health: health.get(docId) ?? null,
          spark: perDayCounts(rows, SPARK_DAYS, now),
          involved: distinctActors(rows),
          lastActivityMineMs: mineMs,
          lastActivityAnyMs: rows.length ? ms(rows[0].at) : null,
          tier: assignedAt.has(docId) ? "assigned" : "mine",
          memexId,
          namespaceSlug: prov.namespaceSlug,
          memexSlug: prov.memexSlug,
          memexName: prov.memexName,
          path: `/${prov.namespaceSlug}/${prov.memexSlug}/specs/${d.handle}`,
        };
      });
    });

  // Fan out across the user's Memexes in bounded-parallel batches (spec-353).
  // Each entry runs inside its own runWithMemexId subtree, so the parallel
  // batches never share RLS context. The final result order is sort-determined
  // below (not insertion order), so collecting in batch order is identical to
  // the prior serial accumulation.
  const entries = [...provByMemex.entries()];
  for (let i = 0; i < entries.length; i += MEMEX_CONCURRENCY) {
    const batch = entries.slice(i, i + MEMEX_CONCURRENCY);
    const results = await Promise.all(
      batch.map(([memexId, prov]) => loadMemexCards(memexId, prov)),
    );
    for (const cards of results) all.push(...cards);
  }

  // tier first (assigned floats up), then MY last activity desc within a tier
  const tierRank = (t: HomeSpecCard["tier"]) => (t === "assigned" ? 0 : 1);
  all.sort(
    (a, b) =>
      tierRank(a.tier) - tierRank(b.tier) ||
      (b.lastActivityMineMs ?? 0) - (a.lastActivityMineMs ?? 0),
  );
  return all;
}
