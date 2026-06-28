// spec-423 t-4 (dec-4) — the routing-decision log: one append-only row per routing
// call capturing query, the full candidate set with all scores, the surfaced-vs-cut
// split, K, and the ranker model. Off the SSE bus (plain insert, not mutate()).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { facetRoutingLog } from "../db/schema.js";
import { makeTestMemex } from "./test-helpers.js";
import { logRouting } from "./facet-routing-log.js";
import type { RoutingResult } from "./facet-routing.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-423";
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;

let memexId: string;

const RESULT: RoutingResult = {
  surfaced: [
    { handle: "std-7", title: "Unauthorized → 404", facetKeys: ["security"], score: 0.91, surfaced: true },
  ],
  all: [
    { handle: "std-7", title: "Unauthorized → 404", facetKeys: ["security"], score: 0.91, surfaced: true },
    { handle: "std-8", title: "Unified bus", facetKeys: ["security"], score: 0.12, surfaced: false },
  ],
  k: 1,
  rankerModel: "cohere:rerank-v3.5",
};

beforeAll(async () => {
  memexId = await makeTestMemex("facrtlog");
});

afterAll(async () => {
  await db.delete(facetRoutingLog).where(eq(facetRoutingLog.memexId, memexId)).catch(() => {});
});

describe("routing-decision log (spec-423 t-4, dec-4)", () => {
  it("appends one row capturing query, full candidate set + all scores, surfaced/cut, K, ranker, owner ref (ac-12)", async () => {
    tagAc(AC(12));
    await logRouting(memexId, `${SPEC}/tasks/t-9`, "task", "build the auth guard", ["security"], RESULT);

    const rows = await db.select().from(facetRoutingLog).where(eq(facetRoutingLog.memexId, memexId));
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.ownerRef).toBe(`${SPEC}/tasks/t-9`);
    expect(row.noun).toBe("task");
    expect(row.queryText).toBe("build the auth guard");
    expect(row.facetKeys).toEqual(["security"]);
    expect(row.k).toBe(1);
    expect(row.rankerModel).toBe("cohere:rerank-v3.5");
    // The FULL candidate set is logged — surfaced AND cut — each with its score.
    expect(row.candidates).toHaveLength(2);
    const surfaced = row.candidates.filter((c) => c.surfaced);
    const cut = row.candidates.filter((c) => !c.surfaced);
    expect(surfaced.map((c) => c.handle)).toEqual(["std-7"]);
    expect(cut.map((c) => c.handle)).toEqual(["std-8"]);
    expect(row.candidates.every((c) => typeof c.score === "number")).toBe(true);
  });

  it("is append-only: a second routing call adds a new row, never overwrites (ac-12)", async () => {
    tagAc(AC(12));
    await logRouting(memexId, `${SPEC}/decisions/dec-1`, "decision", "second call", ["security"], RESULT);
    const rows = await db.select().from(facetRoutingLog).where(eq(facetRoutingLog.memexId, memexId));
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((r) => r.noun))).toEqual(new Set(["task", "decision"]));
  });
});
