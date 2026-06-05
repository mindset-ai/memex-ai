// Handhold onboarding demo — analytics/Pulse exclusion + search inclusion
// (spec-178 t-9, ac-21 + ac-20).
//
// Two guarantees, both tested against REAL Postgres (no mocks):
//
//   ac-21 (Pulse exclusion): listActivity() must drop rows whose `brief_id`
//     references an `is_demo` document, while KEEPING (a) memex-level rows
//     (brief_id IS NULL) and (b) rows for non-demo docs. This is the read-path
//     filter — demo docs may pre-exist the persisted rows, so we cannot rely on
//     a persist-time skip.
//
//   ac-20 (search EXCLUSION): searchMemex() must NOT return a demo spec.
//     spec-178 t-11 / dec-11 reverses the earlier "searchable" posture — a demo
//     spec is invisible AND inert to ⌘K and to the MCP `search_memex` tool. These
//     two cases prove the exclusion on the two arms a demo spec could otherwise
//     surface through: the FTS content arm and the exact-handle short-circuit.
//
// Cleanup deletes activity_log + documents for our memexes, then the namespaces
// (cascading to org/memex/memberships).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { inArray, eq } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { activityLog, documents, memexes, namespaces } from "../db/schema.js";
import type { ActivityLogInsert } from "../db/schema.js";
import { makeTestMemex } from "./test-helpers.js";
import { createDocDraft } from "./documents.js";
import { addSection } from "./sections.js";
import { embedAndStoreDoc } from "./memex-embeddings.js";
import { listActivity } from "./activity-log.js";
import { searchMemex } from "./memex-search.js";
import type { EmbeddingProvider } from "./embedding-provider.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-178/acs/ac-${n}`;

const createdMemexIds: string[] = [];
let memexId: string;

// Deterministic provider so the vector arm never calls a real embedding API.
// Content matters only for FTS here; the vector is a stable hash ramp.
function makeFakeProvider(name = "fake-demo-1536"): EmbeddingProvider {
  return {
    name,
    dim: 1536,
    maxBatchSize: 16,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((t) => {
        const seed = Array.from(t).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
        return Array.from({ length: 1536 }, (_, i) => ((seed + i) % 100) / 100);
      });
    },
  };
}

// Insert one raw activity_log row (the sink's persisted shape) directly, so the
// test controls exactly which brief_id each row references.
async function insertActivity(
  memex: string,
  briefId: string | null,
  narrative: string,
): Promise<string> {
  const row: ActivityLogInsert = {
    memexId: memex,
    briefId,
    actorKind: "system",
    channel: "server",
    entity: "document",
    action: briefId ? "updated" : "created",
    narrative,
  };
  const [inserted] = await db.insert(activityLog).values(row).returning();
  return inserted.id;
}

beforeAll(async () => {
  memexId = await makeTestMemex("demoexcl");
  createdMemexIds.push(memexId);
});

afterAll(async () => {
  await db
    .delete(activityLog)
    .where(inArray(activityLog.memexId, createdMemexIds))
    .catch(() => {});
  await db
    .delete(documents)
    .where(inArray(documents.memexId, createdMemexIds))
    .catch(() => {});
  const memexRows = await db
    .select({ namespaceId: memexes.namespaceId })
    .from(memexes)
    .where(inArray(memexes.id, createdMemexIds))
    .catch(() => [] as { namespaceId: string }[]);
  await db.delete(memexes).where(inArray(memexes.id, createdMemexIds)).catch(() => {});
  const namespaceIds = memexRows.map((r) => r.namespaceId);
  if (namespaceIds.length) {
    await db.delete(namespaces).where(inArray(namespaces.id, namespaceIds)).catch(() => {});
  }
});

// Clean activity_log between cases so row-count assertions are exact.
beforeEach(async () => {
  await db.delete(activityLog).where(inArray(activityLog.memexId, createdMemexIds));
});

describe("listActivity — handhold demo exclusion (ac-21)", () => {
  it("drops activity for is_demo docs but keeps memex-level + non-demo activity", async () => {
    tagAc(AC(21));

    // A demo spec and an ordinary spec.
    const demo = await createDocDraft(memexId, "Demo spec", "Demo overview.", "spec");
    const real = await createDocDraft(memexId, "Real spec", "Real overview.", "spec");
    await db
      .update(documents)
      .set({ isDemo: true })
      .where(eq(documents.id, demo.id));

    // Three activity rows: demo-doc-scoped, real-doc-scoped, memex-level (null).
    const demoRowId = await insertActivity(memexId, demo.id, "edited the demo spec");
    const realRowId = await insertActivity(memexId, real.id, "edited the real spec");
    const memexRowId = await insertActivity(memexId, null, "memex-level event");

    const rows = await listActivity({ memexId });
    const ids = rows.map((r) => r.id);

    // Demo-doc activity is excluded.
    expect(ids).not.toContain(demoRowId);
    // Non-demo + memex-level activity is kept.
    expect(ids).toContain(realRowId);
    expect(ids).toContain(memexRowId);
    expect(rows).toHaveLength(2);
  });

  it("excludes demo activity even when filtering by that demo's briefId", async () => {
    tagAc(AC(21));

    const demo = await createDocDraft(memexId, "Demo spec 2", "Demo overview.", "spec");
    await db
      .update(documents)
      .set({ isDemo: true })
      .where(eq(documents.id, demo.id));
    await insertActivity(memexId, demo.id, "edited the demo spec");

    // Even a briefId-scoped query for the demo doc returns nothing — the demo
    // exclusion is unconditional, not just a default-list filter.
    const rows = await listActivity({ memexId, briefId: demo.id });
    expect(rows).toHaveLength(0);
  });

  it("keeps a non-demo doc's activity that shares a memex with demo docs", async () => {
    tagAc(AC(21));

    const demo = await createDocDraft(memexId, "Demo spec 3", "Demo overview.", "spec");
    const real = await createDocDraft(memexId, "Real spec 3", "Real overview.", "spec");
    await db
      .update(documents)
      .set({ isDemo: true })
      .where(eq(documents.id, demo.id));
    await insertActivity(memexId, demo.id, "demo activity");
    const realRowId = await insertActivity(memexId, real.id, "real activity");

    const rows = await listActivity({ memexId, briefId: real.id });
    expect(rows.map((r) => r.id)).toEqual([realRowId]);
  });
});

describe("searchMemex — demo specs are excluded (ac-20)", () => {
  it("does NOT return an is_demo spec from full-text search", async () => {
    tagAc(AC(20));

    const provider = makeFakeProvider();
    // Unique FTS token so, were the doc NOT a demo, the content arm would
    // deterministically surface it — the exclusion is what keeps it out.
    const token = "handholddemoxyzsearchable";
    const spec = await createDocDraft(
      memexId,
      "Handhold demo searchable spec",
      `This demo overview mentions ${token} so FTS can find it.`,
      "spec",
    );
    await addSection(memexId, spec.id, "scope", `In scope: ${token} coverage.`);
    await db
      .update(documents)
      .set({ isDemo: true })
      .where(eq(documents.id, spec.id));
    await embedAndStoreDoc(spec.id, { provider });

    // FTS-only (vector disabled) so the assertion does not depend on embedding
    // geometry — the content token would resolve the doc if it weren't is_demo.
    const ftsHits = await searchMemex(memexId, token, {
      provider,
      disableVector: true,
    });
    expect(ftsHits.find((h) => h.id === spec.id)).toBeUndefined();
  });

  it("does NOT return an is_demo spec via the handle short-circuit", async () => {
    tagAc(AC(20));

    const provider = makeFakeProvider();
    const spec = await createDocDraft(
      memexId,
      "Handhold demo by handle",
      "Overview.",
      "spec",
    );
    await db
      .update(documents)
      .set({ isDemo: true })
      .where(eq(documents.id, spec.id));
    await embedAndStoreDoc(spec.id, { provider });

    // Even an exact handle lookup must miss a demo spec — the handle
    // short-circuit now carries the same `is_demo IS NOT TRUE` predicate.
    const hits = await searchMemex(memexId, spec.handle, { provider });
    expect(hits.find((h) => h.id === spec.id)).toBeUndefined();
  });
});
