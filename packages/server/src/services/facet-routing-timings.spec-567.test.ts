// spec-567 t-1 (dec-1) — per-stage timings for the standards-routing chain.
//
// The defect: a routed write commits in ~804 ms and then holds the caller ~2 038 ms
// more while routing runs. Nothing in `routeFacets` was ever timed, so the cost could
// not be attributed to a stage — ac-3 was unsatisfiable by construction.
//
// DB-backed because the point is that the REAL segments are measured: a mocked router
// would time stubs and prove nothing. The re-ranker is injected (no network).
//
// dec-4: the query embedding is timed by decorating the provider that `searchMemex`
// already accepts as an option — nothing inside memex-search/retrieval.ts is touched.
// What is NOT separable is the pgvector/FTS cost: those arms run CONCURRENTLY, so the
// third key is `semanticRemainder`, not `search` (ac-11).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  documents,
  docSections,
  standardClauses,
  standardClauseFacets,
  facets,
  namespaces,
  memexes,
  facetRoutingLog,
} from "../db/schema.js";
import { makeTestMemex } from "./test-helpers.js";
import { routeFacets, KEYLESS_MODEL } from "./facet-routing.js";
import { logRouting } from "./facet-routing-log.js";
import type { Reranker } from "./facet-rerank.js";
import type { EmbeddingProvider } from "./embedding-provider.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-567";
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;

// The seven timed segments ac-5 requires. `semanticCandidates` is NOT among them: it was
// replaced by `queryEmbedding` + `semanticRemainder`, which must not double-count or
// `unattributed` stops meaning anything (ac-6).
const SEGMENTS = [
  "generateCandidates",
  "queryEmbedding",
  "semanticRemainder",
  "keylessDensity",
  "sectionDocs",
  "rerank",
  "implicatedSections",
] as const;

let memexId: string;
let orgId: string;
const facetId = new Map<string, string>();

async function orgIdFor(mid: string): Promise<string> {
  const [row] = await db
    .select({ orgId: namespaces.ownerOrgId })
    .from(memexes)
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(memexes.id, mid))
    .limit(1);
  if (!row?.orgId) throw new Error("no org");
  return row.orgId;
}

async function seedStandard(handle: string, title: string, clauseTags: string[][]): Promise<void> {
  const [doc] = await db
    .insert(documents)
    .values({ memexId, handle, title, docType: "standard", status: "approved" })
    .returning();
  const [section] = await db
    .insert(docSections)
    .values({
      memexId,
      docId: doc.id,
      sectionType: "rule",
      content: `${title} — ${clauseTags.flat().join(" ")}`,
      seq: 1,
      position: 1,
    })
    .returning();
  for (let i = 0; i < clauseTags.length; i++) {
    const [cl] = await db
      .insert(standardClauses)
      .values({ memexId, docId: doc.id, sectionId: section.id, seq: i + 1, position: i + 1, body: `clause ${i}` })
      .returning();
    for (const key of clauseTags[i]) {
      await db.insert(standardClauseFacets).values({ memexId, clauseId: cl.id, facetId: facetId.get(key)! });
    }
  }
}

// Injected so the re-rank segment has real elapsed time to measure without a network call.
const SLOW_RERANKER: Reranker = {
  model: "stub:reranker",
  async rerank(_query, docs) {
    await new Promise((r) => setTimeout(r, 25));
    return new Map(docs.map((d, i) => [d.handle, 1 - i * 0.01]));
  },
};

// t-2 — the two failure shapes, as `routeFacets` sees them. `CohereReranker` distinguishes
// an HTTP error from an `AbortController` timeout internally; at THIS seam both arrive as a
// rejected promise, and what separates them is how much time was burned first.
const FAILS_FAST: Reranker = {
  model: "stub:fails-fast",
  async rerank() {
    throw new Error("Cohere rerank failed: 429");
  },
};

// dec-4 (ac-10) — a provider we can COUNT and whose cost we choose. Local runs have no
// COHERE_API_KEY / OPENAI_API_KEY, so `resolveEmbeddingProvider()` returns null and the
// vector arm never runs: injecting one is the only way to exercise the embed at all.
const EMBED_MS = 30;
function countingProvider(): EmbeddingProvider & { calls: number } {
  const p = {
    calls: 0,
    name: "stub:embed",
    dim: 1536,
    maxBatchSize: 96,
    async embed(texts: string[]): Promise<number[][]> {
      p.calls++;
      await new Promise((r) => setTimeout(r, EMBED_MS));
      // A unit vector of the column's width — a zero vector makes cosine distance NaN.
      return texts.map(() => [1, ...Array<number>(1535).fill(0)]);
    },
  };
  return p;
}

const BURNED_MS = 40;
const FAILS_AFTER_BURNING: Reranker = {
  model: "stub:aborts",
  async rerank() {
    await new Promise((r) => setTimeout(r, BURNED_MS));
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    throw err;
  },
};

beforeAll(async () => {
  memexId = await makeTestMemex("f567tim");
  orgId = await orgIdFor(memexId);
  for (const key of ["zt-security", "zt-perf"]) {
    const [f] = await db.insert(facets).values({ ownerType: "org", ownerId: orgId, key, description: key }).returning();
    facetId.set(key, f.id);
  }
  await seedStandard("std-zt-one", "Focused security", [["zt-security"], ["zt-security"]]);
  await seedStandard("std-zt-two", "Mixed", [["zt-security"], ["zt-perf"]]);
});

afterAll(async () => {
  await db.delete(facetRoutingLog).where(eq(facetRoutingLog.memexId, memexId)).catch(() => {});
});

describe("routing timings (spec-567 t-1, dec-1)", () => {
  it("measures every one of the seven segments separately (ac-5)", async () => {
    tagAc(AC(5));
    const result = await routeFacets(
      memexId,
      ["zt-security"],
      "the auth guard on the write path",
      SLOW_RERANKER,
      countingProvider(),
    );

    // Vacuity guard: with no candidates `routeFacets` short-circuits before most of the
    // chain, and every segment would trivially read 0. Assert the full path really ran.
    expect(result.all.length).toBeGreaterThan(0);
    expect(result.rankerModel).toBe("stub:reranker");

    expect(result.timings).toBeDefined();
    for (const key of SEGMENTS) {
      expect(typeof result.timings[key], `segment '${key}' must be timed`).toBe("number");
      expect(result.timings[key]).toBeGreaterThanOrEqual(0);
    }
    // Each segment is its own key — not one rolled-up routing figure.
    expect(new Set(SEGMENTS).size).toBe(SEGMENTS.length);
    // The re-ranker slept 25ms, so its segment cannot be zero: this proves the timer is
    // wired to the re-rank and not reporting a constant.
    expect(result.timings.rerank).toBeGreaterThanOrEqual(20);
  });

  it("carries the total and an explicit unattributed remainder (ac-6)", async () => {
    tagAc(AC(6));
    const result = await routeFacets(memexId, ["zt-security"], "tenancy isolation on the read path", SLOW_RERANKER);
    expect(result.all.length).toBeGreaterThan(0);

    const { total, unattributed } = result.timings;
    const sum = SEGMENTS.reduce((acc, key) => acc + result.timings[key], 0);

    expect(total).toBeGreaterThanOrEqual(sum);
    expect(unattributed).toBe(total - sum);
    // No time may hide: whatever the segments do not account for is named, not dropped.
    expect(total).toBeGreaterThan(0);
  });

  it("writes the timings into ranker_params beside the occasion (ac-6)", async () => {
    tagAc(AC(6));
    const result = await routeFacets(memexId, ["zt-security"], "the deploy gate", SLOW_RERANKER);
    await logRouting(memexId, `${SPEC}/tasks/t-1`, "task", "the deploy gate", ["zt-security"], result, "created");

    const rows = await db.select().from(facetRoutingLog).where(eq(facetRoutingLog.memexId, memexId));
    const row = rows.at(-1)!;
    const params = row.rankerParams as Record<string, unknown>;

    expect(params.occasion).toBe("created");
    const timings = params.timings as Record<string, number>;
    for (const key of SEGMENTS) expect(typeof timings[key]).toBe("number");
    expect(typeof timings.total).toBe("number");
    expect(typeof timings.unattributed).toBe("number");
  });
});

// ── dec-4 (ac-10, ac-11) — the embedding is timed through the seam that existed ──
describe("query-embedding timing (spec-567 dec-4)", () => {
  it("times the injected provider's embed, calling it exactly once (ac-10)", async () => {
    tagAc(AC(10));
    const provider = countingProvider();
    const result = await routeFacets(memexId, ["zt-security"], "the rate limiter", SLOW_RERANKER, provider);

    // Vacuity guard: if the decorator never reached `runSectionVector`, `calls` is 0 and
    // every timing assertion below would be about a call that never happened.
    expect(provider.calls).toBe(1);
    // The measured time tracks the provider's OWN delay — so the decorator wraps the real
    // call rather than reporting a constant.
    expect(result.timings.queryEmbedding).toBeGreaterThanOrEqual(EMBED_MS - 5);
    // …and it is charged to the embedding, not left inside the arm's remainder.
    expect(result.timings.semanticRemainder).toBeLessThan(result.timings.queryEmbedding + EMBED_MS);
  });

  it("names the third key semanticRemainder, never search (ac-11)", async () => {
    tagAc(AC(11));
    const result = await routeFacets(memexId, ["zt-security"], "the rate limiter", SLOW_RERANKER, countingProvider());

    expect(result.timings).toHaveProperty("semanticRemainder");
    // The FTS and vector arms run concurrently inside searchMemex, so no key may claim to
    // be the search's own cost. `semanticCandidates` is gone too: keeping it beside its
    // two parts would double-count and make `unattributed` meaningless.
    expect(result.timings).not.toHaveProperty("search");
    expect(result.timings).not.toHaveProperty("semanticCandidates");
  });
});

// ── t-2 (ac-9) — the burned timeout must stay visible ────────────────────────
//
// prod holds 127 keyless-density rows, and they are NOT "the re-ranker was off":
// COHERE_API_KEY is set, as 22 099 cohere rows prove. They are the FAILURE path, each
// carrying a spent timeout — which is why their p50 is 6 172 ms against cohere's 2 936 ms.
// An instrument that dropped that burned time would push it into `unattributed` and
// regenerate exactly the confound c-1 exposed, this time with per-stage numbers lending
// it credibility. So the re-rank segment is timed in `finally`, and this is what says so.
describe("re-rank timing on the failure path (spec-567 t-2, ac-9)", () => {
  it("keeps the time burned before an abort, and does not leak it into unattributed", async () => {
    tagAc(AC(9));
    const result = await routeFacets(memexId, ["zt-security"], "the retry budget", FAILS_AFTER_BURNING);

    // Vacuity guard: the failure path must actually have been taken. If routing had
    // surfaced nothing, or the re-ranker had somehow succeeded, every assertion below
    // would pass for the wrong reason.
    expect(result.all.length).toBeGreaterThan(0);
    expect(result.rankerModel).toBe(KEYLESS_MODEL);

    // The burned time is charged to the re-rank — neither zero nor absent.
    expect(result.timings.rerank).toBeGreaterThanOrEqual(BURNED_MS - 5);
    // …and it is NOT sitting in the remainder instead.
    expect(result.timings.unattributed).toBeLessThan(BURNED_MS);
    // The segment that completed before the throw still reports its own cost.
    expect(typeof result.timings.sectionDocs).toBe("number");
  });

  it("charges the re-rank ~nothing when it fails immediately", async () => {
    tagAc(AC(9));
    const result = await routeFacets(memexId, ["zt-security"], "the retry budget", FAILS_FAST);

    expect(result.all.length).toBeGreaterThan(0);
    expect(result.rankerModel).toBe(KEYLESS_MODEL);
    // The pair is the point: a timer that always reported a constant — or always zero —
    // would satisfy one of these two tests and fail the other.
    expect(result.timings.rerank).toBeLessThan(BURNED_MS - 5);
  });
});
