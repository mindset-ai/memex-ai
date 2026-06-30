// spec-151 dec-5 / dec-6 — authoring-time + backfill testability classification, end to
// end. add_clause / edit_clause persist an agent-supplied verdict (optional, dec-8
// candidate); the operator backfill fills NULL-verdict clauses and is idempotent under
// --gap-only. The classifier engine is exercised through its `classify` test seam (no LLM).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  users,
  namespaces,
  orgs,
  orgMemberships,
  memexes,
  documents,
  docSections,
  standardClauses,
} from "../db/schema.js";
import { executeServerTool } from "./tools.js";
import { backfillTestabilityForMemex } from "../services/testability-classifier.js";
import type { TestabilityVerdict } from "../services/testability.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-151";
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;

let userId: string;
let memexId: string;
let nsSlug: string;
let sectionRef: string;

async function addClause(body: string, testability?: TestabilityVerdict): Promise<string> {
  const out = await executeServerTool(
    memexId,
    "add_clause",
    { ref: sectionRef, body, ...(testability ? { testability } : {}) },
    userId,
  );
  const seq = out.match(/cl-(\d+)/)![1];
  const [row] = await db
    .select()
    .from(standardClauses)
    .where(and(eq(standardClauses.memexId, memexId), eq(standardClauses.seq, Number(seq))));
  return row.id;
}

beforeAll(async () => {
  // std-37: worker-and-call-unique slug.
  const sub = `t56-${crypto.randomUUID().slice(0, 8)}`.toLowerCase();
  const [u] = await db.insert(users).values({ email: `${sub}@memex.ai` } as never).returning();
  userId = u.id;
  const [ns] = await db.insert(namespaces).values({ slug: sub, kind: "org" }).returning();
  nsSlug = ns.slug;
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: `Test ${sub}` }).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  // No facet vocabulary seeded → add_clause does not require a facet verdict, so these
  // tests exercise the testability path in isolation.
  const [mx] = await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name: "Main" }).returning();
  memexId = mx.id;
  await db.insert(orgMemberships).values({ userId, orgId: org.id, role: "administrator" });

  const [std] = await db
    .insert(documents)
    .values({ memexId, handle: "std-1", title: "A standard", docType: "standard", status: "draft" })
    .returning();
  await db.insert(docSections).values({ docId: std.id, sectionType: "rule", content: "x", seq: 1, position: 1 });
  sectionRef = `${nsSlug}/main/standards/std-1/sections/s-1`;
});

afterAll(async () => {
  await db.delete(documents).where(eq(documents.memexId, memexId)).catch(() => {});
  await db.delete(memexes).where(eq(memexes.id, memexId)).catch(() => {});
  await db.delete(users).where(eq(users.id, userId)).catch(() => {});
});

describe("add_clause persists an agent-supplied testability verdict (spec-151 dec-6)", () => {
  it("persists is_obligation / testable / archetype at authoring time [ac-17]", async () => {
    tagAc(AC(17));
    const clauseId = await addClause("Every mutation must emit on the bus.", {
      isObligation: true,
      testable: true,
      archetype: "static-scan",
    });
    const [row] = await db.select().from(standardClauses).where(eq(standardClauses.id, clauseId));
    expect(row.isObligation).toBe(true);
    expect(row.testable).toBe(true);
    expect(row.archetype).toBe("static-scan");
  });

  it("leaves the verdict NULL (unclassified) when none is supplied — the backfill's gap [ac-17]", async () => {
    tagAc(AC(17));
    const clauseId = await addClause("A motivating example, no rule.");
    const [row] = await db.select().from(standardClauses).where(eq(standardClauses.id, clauseId));
    expect(row.isObligation).toBeNull();
    expect(row.testable).toBeNull();
    expect(row.archetype).toBeNull();
  });
});

describe("edit_clause re-derives the persisted verdict (spec-151 ac-15)", () => {
  it("replaces the verdict when supplied, leaves it when omitted [ac-15]", async () => {
    tagAc(AC(15));
    const clauseId = await addClause("editable rule", {
      isObligation: true,
      testable: true,
      archetype: "grep-denylist",
    });
    const clauseRef = `${nsSlug}/main/standards/std-1/clauses/cl-${(
      await db.select({ seq: standardClauses.seq }).from(standardClauses).where(eq(standardClauses.id, clauseId))
    )[0].seq}`;

    // Re-classify: a body edit changes the testability verdict.
    await executeServerTool(
      memexId,
      "edit_clause",
      { ref: clauseRef, body: "editable rule v2 (now a judgement call)", testability: { isObligation: true, testable: false, archetype: null } },
      userId,
    );
    let [row] = await db.select().from(standardClauses).where(eq(standardClauses.id, clauseId));
    expect(row.testable).toBe(false);
    expect(row.archetype).toBeNull();

    // Omit testability → verdict unchanged.
    await executeServerTool(memexId, "edit_clause", { ref: clauseRef, body: "editable rule v3" }, userId);
    [row] = await db.select().from(standardClauses).where(eq(standardClauses.id, clauseId));
    expect(row.testable).toBe(false);
  });
});

describe("backfill fills NULL-verdict clauses, idempotently (spec-151 ac-19)", () => {
  it("gap-backfill classifies only unclassified clauses and a second run touches nothing [ac-19]", async () => {
    tagAc(AC(19));
    // Two fresh unclassified clauses.
    await addClause("clause to backfill A");
    await addClause("clause to backfill B");

    // Deterministic stub stands in for the LLM (no key needed).
    let calls = 0;
    const classify = (body: string): TestabilityVerdict => {
      calls += 1;
      return { isObligation: true, testable: true, archetype: body.includes("A") ? "static-scan" : "grep-denylist" };
    };

    const first = await backfillTestabilityForMemex(memexId, { gapOnly: true, classify, concurrency: 2 });
    expect(first.clauses).toBeGreaterThanOrEqual(2);
    const callsAfterFirst = calls;
    expect(callsAfterFirst).toBeGreaterThanOrEqual(2);

    // Every clause now has a verdict, so a second gap-only run classifies NOTHING new.
    const second = await backfillTestabilityForMemex(memexId, { gapOnly: true, classify, concurrency: 2 });
    expect(second.clauses).toBe(0);
    expect(calls).toBe(callsAfterFirst); // classify never called again
  });
});
