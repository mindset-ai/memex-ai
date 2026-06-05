import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { memexes, documents, docSections } from "../db/schema.js";
import { listDocs } from "../services/documents.js";
import { makeTestMemex } from "../services/test-helpers.js";

const memexIds: string[] = [];

afterAll(async () => {
  if (memexIds.length) {
    await db.delete(memexes).where(inArray(memexes.id, memexIds)).catch(() => {});
  }
});

// Target tenant for the list-docs scale test. Seeded once in beforeAll.
let targetMemexId = "";
// Other tenants that also carry documents — exist to confirm the account_id filter
// isolates results (and that cross-tenant doc volume doesn't blow the query budget).
const otherAccountIds: string[] = [];

const DOCS_PER_TARGET = 500;
const OTHER_ACCOUNTS = 10;
const DOCS_PER_OTHER = 100;

describe("perf: list-docs at scale", () => {
  beforeAll(async () => {
    targetMemexId = await makeTestMemex("pq-target");
    memexIds.push(targetMemexId);

    // Bulk-insert target tenant's docs + one purpose section each.
    const targetDocs = Array.from({ length: DOCS_PER_TARGET }, (_, i) => ({
      memexId: targetMemexId,
      handle: `doc-${i + 1}`,
      title: `Target doc ${i + 1}`,
      docType: "spec",
      status: "draft",
    }));
    const insertedTarget = await db.insert(documents).values(targetDocs).returning({
      id: documents.id,
    });
    const targetSections = insertedTarget.map((d) => ({
      docId: d.id,
      sectionType: "purpose",
      title: "Purpose",
      content: "scale test",
      seq: 1,
      position: 1,
    }));
    await db.insert(docSections).values(targetSections);

    // Seed the noise tenants so cross-tenant volume is realistic.
    for (let a = 0; a < OTHER_ACCOUNTS; a++) {
      const id = await makeTestMemex(`pq-other-${a}`);
      otherAccountIds.push(id);
      memexIds.push(id);
      const otherDocs = Array.from({ length: DOCS_PER_OTHER }, (_, i) => ({
        memexId: id,
        handle: `doc-${i + 1}`,
        title: `Other ${a}/${i}`,
        docType: "spec",
        status: "draft",
      }));
      await db.insert(documents).values(otherDocs);
    }
  }, 60_000);

  it(`listDocs returns only the target tenant's ${DOCS_PER_TARGET} docs under 500ms`, async () => {
    // Warmup — first query can pay plan/stat costs the index covers afterward.
    await listDocs(targetMemexId);

    const t0 = performance.now();
    const rows = await listDocs(targetMemexId);
    const elapsed = performance.now() - t0;

    expect(rows).toHaveLength(DOCS_PER_TARGET);
    // Every row belongs to the target account — no cross-tenant leak.
    for (const r of rows) expect(r.memexId).toBe(targetMemexId);
    // Index on account_id should keep this well under 500ms locally.
    expect(elapsed).toBeLessThan(500);
  }, 30_000);
});
