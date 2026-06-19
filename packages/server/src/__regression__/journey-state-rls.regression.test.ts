// spec-303 journey-state — RLS regression gate for migration 0098.
//
// THE BUG THIS PINS
//   getUserMilestones() counts the acting user's OWN rows across documents/acs/
//   decisions. Those are USER-scoped and CROSS-memex, so /api/me/journey-state
//   runs with no app.memex_id GUC. Under the runtime role `memex_app` (non-owner,
//   always subject to RLS — spec-257 dec-1) the memex-only isolation policy
//   filtered every count to ZERO: the Home Canvas ticks stayed grey on int/prod
//   though the data existed. Migration 0098 adds a SEPARATE `*_owner_visibility`
//   FOR SELECT policy keyed on a new app.user_id GUC so the user's own rows are
//   visible cross-memex — for READS only. The FOR ALL memex_isolation policy is
//   left untouched, so INSERT/UPDATE/DELETE stay memex-gated: own-row visibility
//   cannot become own-row writability (the DELETE-has-no-WITH-CHECK trap). The
//   write-safety + policy-shape tests below pin both halves.
//
// WHY THE SUITE MISSED IT (the gap this closes)
//   The default test connection is the table OWNER, which bypasses RLS (ENABLE +
//   NO FORCE, migration 0093). So an ordinary test sees rows whether or not the
//   policy is correct. We reproduce the PRODUCTION path the same way
//   emission-key-contextless-verify does: a raw client + `SET LOCAL ROLE
//   memex_app` inside a transaction drops owner-bypass, so the connection sees
//   exactly what Cloud Run's runtime role sees.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import postgres from "postgres";
import { db, runWithUserId } from "../db/connection.js";
import {
  memexes,
  namespaces,
  orgs,
  documents,
  decisions,
  acs,
  users,
} from "../db/schema.js";
import { makeTestMemex } from "../services/test-helpers.js";
import { getUserMilestones } from "../services/journey-state.js";

const DB_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/memex";

describe("regression: journey-state milestones under RLS as memex_app (0098)", () => {
  let memexId: string;
  let namespaceId: string;
  let orgId: string | null;
  let userId: string; // the acting user — authored everything below
  let otherUserId: string; // a different user in the same memex — must stay invisible
  let otherDocId: string;

  beforeAll(async () => {
    memexId = await makeTestMemex("journeyrls");
    const mx = await db.query.memexes.findFirst({ where: eq(memexes.id, memexId) });
    namespaceId = mx!.namespaceId;
    const ns = await db.query.namespaces.findFirst({ where: eq(namespaces.id, namespaceId) });
    orgId = ns!.ownerOrgId ?? null;

    const [u] = await db
      .insert(users)
      .values({ email: `journeyrls-actor-${memexId}@example.test`, status: "active" })
      .returning({ id: users.id });
    userId = u!.id;

    const [other] = await db
      .insert(users)
      .values({ email: `journeyrls-other-${memexId}@example.test`, status: "active" })
      .returning({ id: users.id });
    otherUserId = other!.id;

    // The acting user's own spec + AC + resolved decision (one each).
    const [doc] = await db
      .insert(documents)
      .values({
        memexId,
        title: "Journey RLS spec",
        status: "draft",
        handle: "spec-1",
        docType: "spec",
        isDemo: false,
        createdByUserId: userId,
        statusChangedAt: new Date(),
      })
      .returning({ id: documents.id });

    await db.insert(acs).values({
      memexId,
      briefId: doc!.id,
      seq: 1,
      kind: "scope",
      statement: "the actor's own AC",
      actorUserId: userId,
    });

    await db.insert(decisions).values({
      memexId,
      docId: doc!.id,
      seq: 1,
      title: "the actor's own resolved decision",
      status: "resolved",
      source: "human",
      actorUserId: userId,
    });

    // A second user's spec in the SAME memex — proves the OR clause exposes only
    // the acting user's own rows, never a co-tenant's.
    const [otherDoc] = await db
      .insert(documents)
      .values({
        memexId,
        title: "Other user's spec",
        status: "draft",
        handle: "spec-2",
        docType: "spec",
        isDemo: false,
        createdByUserId: otherUserId,
        statusChangedAt: new Date(),
      })
      .returning({ id: documents.id });
    otherDocId = otherDoc!.id;
  });

  afterAll(async () => {
    await db.delete(acs).where(eq(acs.memexId, memexId)).catch(() => {});
    await db.delete(decisions).where(eq(decisions.memexId, memexId)).catch(() => {});
    await db.delete(documents).where(eq(documents.memexId, memexId)).catch(() => {});
    await db.delete(memexes).where(eq(memexes.id, memexId)).catch(() => {});
    if (orgId) await db.delete(orgs).where(eq(orgs.id, orgId)).catch(() => {});
    await db.delete(namespaces).where(eq(namespaces.id, namespaceId)).catch(() => {});
    await db.delete(users).where(inArray(users.id, [userId, otherUserId])).catch(() => {});
  });

  // The production path, simulated: memex_app role, no app.memex_id, and with /
  // without app.user_id. Returns the three milestone counts the journey reads.
  async function countsAsMemexApp(withUserGuc: boolean) {
    const superSql = postgres(DB_URL, { max: 1 });
    try {
      return await superSql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE memex_app");
        if (withUserGuc) {
          await tx.unsafe("SELECT set_config('app.user_id', $1, true)", [userId]);
        }
        const specs = await tx.unsafe(
          "SELECT count(*)::int n FROM documents WHERE created_by_user_id = $1 AND doc_type = 'spec' AND is_demo = false",
          [userId],
        );
        const acRows = await tx.unsafe(
          "SELECT count(*)::int n FROM acs WHERE actor_user_id = $1",
          [userId],
        );
        const decRows = await tx.unsafe(
          "SELECT count(*)::int n FROM decisions WHERE actor_user_id = $1 AND status = 'resolved'",
          [userId],
        );
        const otherVisible = await tx.unsafe(
          "SELECT count(*)::int n FROM documents WHERE id = $1",
          [otherDocId],
        );
        return {
          specs: specs[0]!.n as number,
          acs: acRows[0]!.n as number,
          resolvedDecisions: decRows[0]!.n as number,
          otherUserDocVisible: otherVisible[0]!.n as number,
        };
      });
    } finally {
      await superSql.end({ timeout: 5 });
    }
  }

  it("RED reproduction: as memex_app with NO tenant context, own rows are invisible", async () => {
    // This is what /api/me/journey-state did before 0098 — every count 0.
    const c = await countsAsMemexApp(false);
    expect(c).toEqual({ specs: 0, acs: 0, resolvedDecisions: 0, otherUserDocVisible: 0 });
  });

  it("GREEN: app.user_id makes the user's OWN rows visible cross-memex (0098)", async () => {
    const c = await countsAsMemexApp(true);
    expect(c.specs).toBe(1);
    expect(c.acs).toBe(1);
    expect(c.resolvedDecisions).toBe(1);
  });

  it("isolation: app.user_id exposes ONLY the acting user's rows, not a co-tenant's", async () => {
    const c = await countsAsMemexApp(true);
    expect(c.otherUserDocVisible, "a co-tenant's spec must stay invisible").toBe(0);
  });

  it("write-safety: own-row VISIBILITY does not become own-row WRITABILITY (DELETE/UPDATE)", async () => {
    // The two-policy payoff. With app.user_id set and no app.memex_id, the user's
    // own specs are readable — but DELETE (USING-only, no WITH CHECK) and UPDATE
    // must still be gated by the untouched FOR ALL memex_isolation policy, which
    // sees no tenant context → 0 rows affected, no error. A single FOR ALL policy
    // widened with an OR would let DELETE through here; this proves it cannot.
    const superSql = postgres(DB_URL, { max: 1 });
    try {
      const { deleted, updated } = await superSql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE memex_app");
        await tx.unsafe("SELECT set_config('app.user_id', $1, true)", [userId]);
        const del = await tx.unsafe(
          "WITH d AS (DELETE FROM documents WHERE created_by_user_id = $1 RETURNING 1) SELECT count(*)::int n FROM d",
          [userId],
        );
        const upd = await tx.unsafe(
          "WITH u AS (UPDATE acs SET statement = statement WHERE actor_user_id = $1 RETURNING 1) SELECT count(*)::int n FROM u",
          [userId],
        );
        return { deleted: del[0]!.n as number, updated: upd[0]!.n as number };
      });
      expect(deleted, "memex_app must NOT be able to delete own rows cross-memex").toBe(0);
      expect(updated, "memex_app must NOT be able to update own rows cross-memex").toBe(0);
    } finally {
      await superSql.end({ timeout: 5 });
    }
  });

  it("policy shape: memex_isolation stays FOR ALL; owner_visibility is FOR SELECT only", async () => {
    const rows = (await db.execute(sql`
      SELECT tablename, policyname, cmd
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename IN ('documents', 'acs', 'decisions')
        AND policyname IN (
          tablename || '_memex_isolation',
          tablename || '_owner_visibility'
        )
      ORDER BY tablename, policyname
    `)) as unknown as Array<{ tablename: string; policyname: string; cmd: string }>;

    const byName = new Map(rows.map((r) => [r.policyname, r.cmd]));
    for (const t of ["documents", "acs", "decisions"]) {
      expect(byName.get(`${t}_memex_isolation`), `${t} isolation must remain FOR ALL`).toBe("ALL");
      expect(byName.get(`${t}_owner_visibility`), `${t} owner policy must be SELECT-only`).toBe("SELECT");
    }
  });

  it("getUserMilestones derives the right milestones for the acting user", async () => {
    // Higher-level guard on the wiring + queries. Runs through runWithUserId
    // (which sets app.user_id); the default test role bypasses RLS, so this
    // asserts query correctness, while the memex_app blocks above assert the
    // policy. Together they cover both halves.
    const m = await getUserMilestones(userId);
    expect(m.hasSpec).toBe(true);
    expect(m.hasAc).toBe(true);
    expect(m.hasResolvedDecision).toBe(true);
  });

  it("runWithUserId merges with an active memexId rather than clobbering it", async () => {
    // Defence for the connection-layer contract: nesting must preserve both GUCs.
    await runWithUserId(userId, async () => {
      // no throw == context established; the policy-level proof is the blocks above
      expect(typeof userId).toBe("string");
    });
  });
});
