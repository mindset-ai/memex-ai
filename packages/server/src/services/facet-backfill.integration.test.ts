// spec-340 t-11 — the backfill that classifies existing standards' clauses. The
// loop is tested with an INJECTED classifier (no real LLM); a guard pins that the
// LLM engine is never reachable from a server request handler/route.

import { describe, it, expect, beforeAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { eq } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { db } from "../db/connection.js";
import {
  standardClauseFacets,
  documents,
  docSections,
  standardClauses,
  namespaces,
  memexes,
} from "../db/schema.js";
import { makeTestMemex } from "./test-helpers.js";
import { seedDefaultFacets } from "./default-facets.js";
import { backfillFacetTagsForMemex, standardPillSet } from "./facet-classifier.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-340/acs/ac-${n}`;

let memexId: string;
let stdAId: string;

async function makeStandard(handle: string, bodies: string[]): Promise<string> {
  const [doc] = await db
    .insert(documents)
    .values({ memexId, handle, title: handle, docType: "standard", status: "approved" })
    .returning();
  const [section] = await db
    .insert(docSections)
    .values({ docId: doc.id, sectionType: "rule", content: "x", seq: 1, position: 1 })
    .returning();
  for (let i = 0; i < bodies.length; i++) {
    await db
      .insert(standardClauses)
      .values({ memexId, docId: doc.id, sectionId: section.id, seq: i + 1, position: i + 1, body: bodies[i] });
  }
  return doc.id;
}

beforeAll(async () => {
  memexId = await makeTestMemex("fbkf");
  const [row] = await db
    .select({ orgId: namespaces.ownerOrgId })
    .from(memexes)
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(memexes.id, memexId))
    .limit(1);
  await seedDefaultFacets(row!.orgId!);
  stdAId = await makeStandard("std-bf-a", [
    "All endpoints must return 404 not 403 for unauthorized resources.",
    "This is background rationale, governing nothing.",
  ]);
  await makeStandard("std-bf-b", ["Every migration must enable row level security."]);
});

describe("backfillFacetTagsForMemex (spec-340 t-11)", () => {
  it("classifies + tags every clause of every standard, with the LLM injected (ac-29)", async () => {
    tagAc(AC(29));
    const fakeClassify = (body: string): string[] => {
      if (body.includes("404")) return ["security", "api-design"];
      if (body.includes("migration")) return ["db-migrations"];
      return []; // the rationale clause governs nothing
    };

    const res = await backfillFacetTagsForMemex(memexId, { classify: fakeClassify });
    expect(res.standards).toBe(2);
    expect(res.clauses).toBe(3);

    // 2 member rows (std-a clause1) + 1 none-marker (std-a clause2) + 1 member (std-b) = 4
    const allTags = await db.select().from(standardClauseFacets).where(eq(standardClauseFacets.memexId, memexId));
    expect(allTags).toHaveLength(4);

    // and the pills rolled up
    expect(await standardPillSet(memexId, stdAId)).toEqual(["api-design", "security"]);
  });

  it("the LLM classifier engine is never reachable from a server request handler or route (ac-29)", () => {
    tagAc(AC(29));
    const dirs = [join(__dirname, "..", "agent", "handlers"), join(__dirname, "..", "routes")];
    const FORBIDDEN = /classifyClauseWithLlm|classifyStandard|backfillFacetTagsForMemex/;
    for (const dir of dirs) {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".ts") || f.includes(".test.")) continue;
        const src = readFileSync(join(dir, f), "utf8");
        expect(FORBIDDEN.test(src), `${f} must not reference the LLM classifier engine`).toBe(false);
      }
    }
  });
});
