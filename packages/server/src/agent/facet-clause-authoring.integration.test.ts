// spec-423 t-6 (dec-9) — authoring-time clause classification. add_clause hard-requires
// a facet verdict (rejecting absent / unknown-key with the vocabulary re-handed);
// edit_clause's verdict is optional. End-to-end through executeServerTool.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { and, eq, isNull } from "drizzle-orm";
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
  standardClauseFacets,
  facets,
} from "../db/schema.js";
import { executeServerTool } from "./tools.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-423";
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;

let userId: string;
let memexId: string;
let nsSlug: string;
let sectionRef: string;
const facetId = new Map<string, string>();

async function clauseIdFromOutput(out: string): Promise<string> {
  const seq = out.match(/cl-(\d+)/)?.[1];
  const [row] = await db
    .select({ id: standardClauses.id })
    .from(standardClauses)
    .where(and(eq(standardClauses.memexId, memexId), eq(standardClauses.seq, Number(seq))));
  return row.id;
}

beforeAll(async () => {
  const sub = `t6-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
  const [u] = await db.insert(users).values({ email: `${sub}@memex.ai` } as never).returning();
  userId = u.id;
  const [ns] = await db.insert(namespaces).values({ slug: sub, kind: "org" }).returning();
  nsSlug = ns.slug;
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: `Test ${sub}` }).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [mx] = await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name: "Main" }).returning();
  memexId = mx.id;
  await db.insert(orgMemberships).values({ userId, orgId: org.id, role: "administrator" });

  for (const key of ["xd-security", "xd-perf"]) {
    const [f] = await db.insert(facets).values({ ownerType: "org", ownerId: org.id, key, description: key }).returning();
    facetId.set(key, f.id);
  }

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

describe("add_clause hard-fails without a valid facet verdict (spec-423 t-6, dec-9)", () => {
  it("rejects an absent verdict, re-handing the valid keys + the facets list verb (ac-16, ac-8)", async () => {
    tagAc(AC(16));
    tagAc(AC(8)); // scope: authoring a standard keeps clauses facet-tagged (add_clause requires a verdict)
    await expect(
      executeServerTool(memexId, "add_clause", { ref: sectionRef, body: "a rule" }, userId),
    ).rejects.toThrow(/xd-security[\s\S]*facets/);
  });

  it("rejects an unknown facet key (ac-16)", async () => {
    tagAc(AC(16));
    await expect(
      executeServerTool(memexId, "add_clause", { ref: sectionRef, body: "a rule", facets: ["made-up"] }, userId),
    ).rejects.toThrow(/Unknown facet key/);
  });

  it("accepts a valid verdict and persists member rows (ac-16)", async () => {
    tagAc(AC(16));
    const out = await executeServerTool(
      memexId,
      "add_clause",
      { ref: sectionRef, body: "auth rule", facets: ["xd-security"] },
      userId,
    );
    const clauseId = await clauseIdFromOutput(out);
    const tags = await db.select().from(standardClauseFacets).where(eq(standardClauseFacets.clauseId, clauseId));
    expect(tags).toHaveLength(1);
    expect(tags[0].facetId).toBe(facetId.get("xd-security"));
  });

  it("accepts an explicit empty verdict ([]) as the governs-nothing marker (ac-16)", async () => {
    tagAc(AC(16));
    const out = await executeServerTool(
      memexId,
      "add_clause",
      { ref: sectionRef, body: "a definition", facets: [] },
      userId,
    );
    const clauseId = await clauseIdFromOutput(out);
    const none = await db
      .select()
      .from(standardClauseFacets)
      .where(and(eq(standardClauseFacets.clauseId, clauseId), isNull(standardClauseFacets.facetId)));
    expect(none).toHaveLength(1); // explicit "governs nothing"
  });
});

describe("edit_clause re-classifies optionally (spec-423 t-6, dec-9)", () => {
  it("replaces tags when a verdict is given, leaves them when omitted (ac-16)", async () => {
    tagAc(AC(16));
    const out = await executeServerTool(
      memexId,
      "add_clause",
      { ref: sectionRef, body: "editable", facets: ["xd-security"] },
      userId,
    );
    const clauseId = await clauseIdFromOutput(out);
    const clauseRef = `${nsSlug}/main/standards/std-1/clauses/cl-${out.match(/cl-(\d+)/)![1]}`;

    // Re-specify → tags replaced.
    await executeServerTool(memexId, "edit_clause", { ref: clauseRef, body: "editable v2", facets: ["xd-perf"] }, userId);
    let tags = await db.select().from(standardClauseFacets).where(eq(standardClauseFacets.clauseId, clauseId));
    expect(tags.map((t) => t.facetId)).toEqual([facetId.get("xd-perf")]);

    // Omit facets → tags unchanged.
    await executeServerTool(memexId, "edit_clause", { ref: clauseRef, body: "editable v3" }, userId);
    tags = await db.select().from(standardClauseFacets).where(eq(standardClauseFacets.clauseId, clauseId));
    expect(tags.map((t) => t.facetId)).toEqual([facetId.get("xd-perf")]);
  });
});
