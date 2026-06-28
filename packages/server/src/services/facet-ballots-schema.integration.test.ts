// spec-423 t-1 — schema shape for the consume-side ballot + routing-log substrate
// (dec-7, ac-15). DB-backed: the constraints (one-ballot-per-noun uniqueness, the
// ENABLE-not-FORCE RLS posture, the complete-map columns) are enforced by Postgres,
// so a pure unit test on the Drizzle objects could pass while the migration is wrong.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  documents,
  tasks,
  decisions,
  taskFacetBallots,
  decisionFacetBallots,
  facetRoutingLog,
} from "../db/schema.js";
import { makeTestMemex } from "./test-helpers.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-423";
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;

let memexId: string;
let docId: string;
let taskId: string;
let decisionId: string;

beforeAll(async () => {
  memexId = await makeTestMemex("facbal");
  const [doc] = await db
    .insert(documents)
    .values({ memexId, handle: "spec-facbal", title: "Ballot schema test spec", docType: "spec", status: "build" })
    .returning();
  docId = doc.id;
  const [task] = await db
    .insert(tasks)
    .values({ memexId, docId, seq: 1, title: "t", description: "d" })
    .returning();
  taskId = task.id;
  const [decision] = await db
    .insert(decisions)
    .values({ memexId, docId, seq: 1, title: "dec" })
    .returning();
  decisionId = decision.id;
});

afterAll(async () => {
  if (docId) await db.delete(documents).where(eq(documents.id, docId)).catch(() => {});
});

async function columnsOf(table: string): Promise<Set<string>> {
  const rows = await db.execute<{ column_name: string }>(
    sql`SELECT column_name FROM information_schema.columns WHERE table_name = ${table}`,
  );
  return new Set((rows as unknown as { column_name: string }[]).map((r) => r.column_name));
}

async function rlsPosture(table: string): Promise<{ enabled: boolean; forced: boolean }> {
  const rows = await db.execute<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
    sql`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ${table}`,
  );
  const r = (rows as unknown as { relrowsecurity: boolean; relforcerowsecurity: boolean }[])[0];
  return { enabled: r.relrowsecurity, forced: r.relforcerowsecurity };
}

describe("consume-side ballot tables — bespoke per-noun shape (spec-423 t-1, dec-7)", () => {
  it("task_facet_ballots + decision_facet_ballots carry verdict/none/vocabulary_keys + std-32 actor + memex_id (ac-15)", async () => {
    tagAc(AC(15));
    for (const t of ["task_facet_ballots", "decision_facet_ballots"]) {
      const cols = await columnsOf(t);
      for (const c of ["memex_id", "verdict", "none", "vocabulary_keys", "actor_user_id", "actor_name", "channel"]) {
        expect(cols.has(c), `${t}.${c}`).toBe(true);
      }
    }
    expect((await columnsOf("task_facet_ballots")).has("task_id")).toBe(true);
    expect((await columnsOf("decision_facet_ballots")).has("decision_id")).toBe(true);
  });

  it("all three consume-side tables are ENABLE-not-FORCE RLS (std-36, ac-15)", async () => {
    tagAc(AC(15));
    for (const t of ["task_facet_ballots", "decision_facet_ballots", "facet_routing_log"]) {
      const { enabled, forced } = await rlsPosture(t);
      expect(enabled, `${t} RLS enabled`).toBe(true);
      expect(forced, `${t} RLS NOT forced`).toBe(false);
    }
  });

  it("enforces one ballot per task / per decision (upsert target) (ac-15)", async () => {
    tagAc(AC(15));
    const vocab = ["security"];
    await db.insert(taskFacetBallots).values({
      memexId, taskId, verdict: { security: true }, none: false, vocabularyKeys: vocab,
    });
    await expect(
      db.insert(taskFacetBallots).values({
        memexId, taskId, verdict: { security: false }, none: false, vocabularyKeys: vocab,
      }),
    ).rejects.toThrow();

    await db.insert(decisionFacetBallots).values({
      memexId, decisionId, verdict: { security: true }, none: false, vocabularyKeys: vocab,
    });
    await expect(
      db.insert(decisionFacetBallots).values({
        memexId, decisionId, verdict: { security: false }, none: false, vocabularyKeys: vocab,
      }),
    ).rejects.toThrow();
  });

  it("stores the complete boolean verdict map + vocabulary snapshot round-trip (ac-15)", async () => {
    tagAc(AC(15));
    const [row] = await db.select().from(taskFacetBallots).where(eq(taskFacetBallots.taskId, taskId));
    expect(row.verdict).toEqual({ security: true });
    expect(row.vocabularyKeys).toEqual(["security"]);
    expect(row.none).toBe(false);
  });
});

describe("facet_routing_log — append-only routing telemetry (spec-423 t-4, dec-4)", () => {
  it("carries query, candidates, all scores, k, ranker provenance, owning ref (ac-15)", async () => {
    tagAc(AC(15));
    const cols = await columnsOf("facet_routing_log");
    for (const c of ["memex_id", "owner_ref", "noun", "query_text", "facet_keys", "candidates", "k", "ranker_model"]) {
      expect(cols.has(c), `facet_routing_log.${c}`).toBe(true);
    }
    // Round-trip a candidate set with surfaced/cut flags + scores.
    await db.insert(facetRoutingLog).values({
      memexId, ownerRef: `${SPEC}/tasks/t-1`, noun: "task", queryText: "q", facetKeys: ["security"],
      candidates: [
        { handle: "std-7", title: "A", score: 0.9, surfaced: true },
        { handle: "std-8", title: "B", score: 0.1, surfaced: true },
      ],
      k: 10, rankerModel: "keyless-density",
    });
    const [row] = await db.select().from(facetRoutingLog).where(eq(facetRoutingLog.memexId, memexId));
    expect(row.candidates).toHaveLength(2);
    expect(row.candidates[0].score).toBe(0.9);
    expect(row.k).toBe(10);
  });
});
