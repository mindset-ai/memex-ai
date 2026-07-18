// spec-497 (t-4/t-5/t-6) — the knowledge-graph read model + route, end to end.
//
// One SQL-aggregated, memex-scoped payload: facet / standard / spec / decision nodes
// and typed edges (spec→decision, standard→facet, decision→facet, mentions, semantic,
// drift), plus meta. Tests exercise the real service against a seeded DB and the route
// through tenant + session middleware. Covers ac-1..6, 10, 12, 13, 14, 15.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { and, eq, inArray } from "drizzle-orm";

vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = "";
  return undefined;
});
// Keep the fire-and-forget section embed from racing (keyless it no-ops; with a key it
// writes) — this suite doesn't assert semantic edges, but std-37 wants determinism.
vi.mock("../services/memex-embeddings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/memex-embeddings.js")>()),
  embedAndStoreSection: async () => {},
  embedAndStoreDoc: async () => {},
}));

import { db } from "../db/connection.js";
import { documents, decisions, tasks, facets, namespaces, memexes } from "../db/schema.js";
import { app } from "../app.js";
import {
  makeTestMemex,
  makePersonalTestMemex,
  makeTestMemexWithDevAdmin,
} from "./test-helpers.js";
import { seedDefaultFacetsForOwner } from "./default-facets.js";
import { listFacetsForMemex, persistClauseFacets } from "./facet-vocab.js";
import { ownerForMemex } from "./shared/memex-ownership.js";
import { castDecisionBallot, type BallotInput } from "./facet-ballot.js";
import { createDocDraft } from "./documents.js";
import { createDecision, resolveDecision } from "./decisions.js";
import { addSection } from "./sections.js";
import { createClause } from "./clauses.js";
import { flagDrift } from "./standards.js";
import { standardsGraph } from "./standards-graph.js";
import { knowledgeGraph } from "./knowledge-graph.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-497";
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;

const createdDocIds: string[] = [];
const memexIds: string[] = [];

// A COMPLETE verdict over the memex's vocabulary, with the given keys true.
async function fullBallot(memexId: string, trueKeys: string[]): Promise<BallotInput> {
  const vocab = await listFacetsForMemex(memexId);
  const verdict: Record<string, boolean> = {};
  for (const f of vocab) verdict[f.key] = trueKeys.includes(f.key);
  return { verdict, none: trueKeys.length === 0 };
}

async function facetIdByKey(memexId: string, key: string): Promise<string> {
  // Scope to THIS memex's owner — default facets share keys across owners, so an
  // unscoped lookup would collide under parallel execution (std-37).
  const owner = await ownerForMemex(memexId);
  const [row] = await db
    .select({ id: facets.id })
    .from(facets)
    .where(and(eq(facets.ownerType, owner!.ownerType), eq(facets.ownerId, owner!.ownerId), eq(facets.key, key)))
    .limit(1);
  return row!.id;
}

async function orgIdFor(memexId: string): Promise<string> {
  const [row] = await db
    .select({ orgId: namespaces.ownerOrgId })
    .from(memexes)
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(memexes.id, memexId))
    .limit(1);
  return row!.orgId!;
}

// The primary org memex fully wired: 16 facets, one standard (2 clauses: one tagged
// security, one governs-nothing), one spec with two decisions (dec-A resolved+security,
// dec-B open+db-migrations), a drift edge on dec-A, and a link-less drift comment.
let memexId: string;
let standardDocId: string;
let standardSectionId: string;
let specDocId: string;
let decA: { id: string; seq: number };
let decB: { id: string; seq: number };
let securityFacetId: string;
let dbMigrationsFacetId: string;

beforeAll(async () => {
  memexId = await makeTestMemex("kg");
  memexIds.push(memexId);
  await seedDefaultFacetsForOwner({ ownerType: "org", ownerId: await orgIdFor(memexId) });
  securityFacetId = await facetIdByKey(memexId, "security");
  dbMigrationsFacetId = await facetIdByKey(memexId, "db-migrations");

  // Standard with two clauses.
  const [std] = await db
    .insert(documents)
    .values({ memexId, handle: "std-1", title: "Security standard", docType: "standard" })
    .returning();
  standardDocId = std.id;
  createdDocIds.push(std.id);
  const section = await addSection(memexId, std.id, "rule", "Rule prose.");
  standardSectionId = section.id;
  const clauseTagged = await createClause(memexId, section.id, "- Secrets must be encrypted.\n");
  const clauseNone = await createClause(memexId, section.id, "- This is a definition clause.\n");
  // Tag clause 1 with security; clause 2 = governs-nothing (NULL marker).
  await persistClauseFacets(memexId, std.id, clauseTagged.id, [securityFacetId]);
  await persistClauseFacets(memexId, std.id, clauseNone.id, []);

  // Spec with two decisions + ballots.
  const spec = await createDocDraft(memexId, "KG spec", "purpose", "spec");
  specDocId = spec.id;
  createdDocIds.push(spec.id);

  const dA = await createDecision(memexId, spec.id, "Encrypt secrets at rest");
  decA = { id: dA.id, seq: dA.seq };
  await castDecisionBallot(memexId, spec.id, dA.id, await fullBallot(memexId, ["security"]));
  await resolveDecision(memexId, dA.id, "Use envelope encryption");

  const dB = await createDecision(memexId, spec.id, "Pick a migration tool");
  decB = { id: dB.id, seq: dB.seq };
  await castDecisionBallot(memexId, spec.id, dB.id, await fullBallot(memexId, ["db-migrations"]));

  // Drift: one linked to dec-A (edge), one link-less (badge only).
  await flagDrift(memexId, standardSectionId, "encryption drift", { driftDecisionId: dA.id });
  await flagDrift(memexId, standardSectionId, "unattributed drift");
});

afterAll(async () => {
  if (createdDocIds.length) {
    await db.delete(tasks).where(inArray(tasks.docId, createdDocIds)).catch(() => {});
    await db.delete(decisions).where(inArray(decisions.docId, createdDocIds)).catch(() => {});
    await db.delete(documents).where(inArray(documents.id, createdDocIds)).catch(() => {});
  }
  const rows = await db.select().from(memexes).where(inArray(memexes.id, memexIds));
  await db
    .delete(facets)
    .where(and(eq(facets.ownerType, "org")))
    .catch(() => {});
  await db
    .delete(namespaces)
    .where(inArray(namespaces.id, rows.map((m) => m.namespaceId)))
    .catch(() => {});
});

describe("knowledgeGraph — one payload, all node & edge families (ac-1)", () => {
  it("returns facet/standard/spec/decision nodes + every typed edge in one call (ac-1)", async () => {
    tagAc(AC(1));
    const g = await knowledgeGraph(memexId, { decisions: "resolved" });

    expect(g.nodes.facets.length).toBe(16);
    expect(g.nodes.standards.map((s) => s.handle)).toContain("std-1");
    expect(g.nodes.specs.map((s) => s.docId)).toContain(specDocId);
    expect(g.nodes.decisions.map((d) => d.id)).toContain(decA.id);

    // spec→decision containment for dec-A.
    expect(g.edges.specDecision).toContainEqual({ specDocId, decisionId: decA.id });
    // standard→facet (security), decision→facet (dec-A→security).
    expect(g.edges.standardFacet.some((e) => e.standardDocId === standardDocId && e.facetId === securityFacetId)).toBe(true);
    expect(g.edges.decisionFacet).toContainEqual({ decisionId: decA.id, facetId: securityFacetId });
    // Edge containers always present (mentions/semantic may be empty here).
    expect(Array.isArray(g.edges.mentions)).toBe(true);
    expect(Array.isArray(g.edges.semantic)).toBe(true);
  });
});

describe("standard→facet aggregation excludes NULL/untagged clauses (ac-15)", () => {
  it("one edge per (standard, facet) with clauseCount + clause evidence; governs-nothing contributes nothing (ac-15)", async () => {
    tagAc(AC(15));
    const g = await knowledgeGraph(memexId);
    const edges = g.edges.standardFacet.filter((e) => e.standardDocId === standardDocId);
    // Only the security tag produced an edge (the governs-nothing clause did not).
    expect(edges).toHaveLength(1);
    expect(edges[0].facetId).toBe(securityFacetId);
    expect(edges[0].clauseCount).toBe(1);
    expect(edges[0].evidence[0].clauseHandle).toMatch(/^cl-\d+$/);
    expect(edges[0].evidence[0].snippet).toContain("Secrets");

    // Standard node reflects: 2 live clauses, 1 tagged, and (see drift) open drift.
    const node = g.nodes.standards.find((s) => s.docId === standardDocId)!;
    expect(node.clauseCount).toBe(2);
    expect(node.taggedClauseCount).toBe(1);
  });
});

describe("drift is a node badge AND a decision→standard edge (ac-2, ac-10)", () => {
  it("openDriftCount counts both drift comments; only the linked one draws an edge (ac-2)", async () => {
    tagAc(AC(2));
    const g = await knowledgeGraph(memexId);
    const node = g.nodes.standards.find((s) => s.docId === standardDocId)!;
    expect(node.openDriftCount).toBe(2); // linked + link-less, both counted

    const edges = g.edges.drift.filter((e) => e.standardDocId === standardDocId);
    expect(edges).toHaveLength(1); // only the linked one
    expect(edges[0]).toMatchObject({ decisionId: decA.id, sectionId: standardSectionId });
    expect(typeof edges[0].commentId).toBe("string");
    expect(typeof edges[0].openedAt).toBe("string");
  });

  it("drift edges come only from the column, not prose (a link-less drift never edges) (ac-10)", async () => {
    tagAc(AC(10));
    const g = await knowledgeGraph(memexId);
    // Every drift edge carries a non-null decisionId sourced from drift_decision_id.
    expect(g.edges.drift.every((e) => typeof e.decisionId === "string" && e.decisionId.length > 0)).toBe(true);
  });
});

describe("decisions filter: resolved | all | none (ac-13)", () => {
  it("default resolved = resolved decisions with ≥1 true facet; all adds open; none is skeleton (ac-13)", async () => {
    tagAc(AC(13));
    const resolved = await knowledgeGraph(memexId, { decisions: "resolved" });
    expect(resolved.nodes.decisions.map((d) => d.id)).toEqual([decA.id]); // dec-B is open
    expect(resolved.meta.decisionFilter).toBe("resolved");

    const all = await knowledgeGraph(memexId, { decisions: "all" });
    const allIds = all.nodes.decisions.map((d) => d.id);
    expect(allIds).toContain(decA.id);
    expect(allIds).toContain(decB.id);
    // facet.decisionCount tracks the included set: security 1 (dec-A), db-migrations 1 (dec-B).
    const sec = all.nodes.facets.find((f) => f.id === securityFacetId)!;
    const dbm = all.nodes.facets.find((f) => f.id === dbMigrationsFacetId)!;
    expect(sec.decisionCount).toBe(1);
    expect(dbm.decisionCount).toBe(1);

    const none = await knowledgeGraph(memexId, { decisions: "none" });
    expect(none.nodes.decisions).toHaveLength(0);
    expect(none.nodes.specs).toHaveLength(0);
    expect(none.edges.decisionFacet).toHaveLength(0);
    // Skeleton still carries facets + standards.
    expect(none.nodes.facets.length).toBe(16);
    expect(none.nodes.standards.length).toBeGreaterThan(0);
  });

  it("specs included are exactly those owning ≥1 included decision (ac-1)", async () => {
    tagAc(AC(1));
    const resolved = await knowledgeGraph(memexId, { decisions: "resolved" });
    // Only the spec owning dec-A is present; its decisionCount reflects included decisions.
    const spec = resolved.nodes.specs.find((s) => s.docId === specDocId)!;
    expect(spec.decisionCount).toBe(1);
  });
});

describe("meta.counts are unfiltered totals (ac-14) + stable ids / SQL aggregation (ac-4)", () => {
  it("counts stay constant across filters; nodes key on stable uuids (ac-14, ac-4)", async () => {
    tagAc(AC(14));
    const resolved = await knowledgeGraph(memexId, { decisions: "resolved" });
    const none = await knowledgeGraph(memexId, { decisions: "none" });
    // decisions total counts both dec-A and dec-B regardless of the filter.
    expect(resolved.meta.counts.decisions).toBe(none.meta.counts.decisions);
    expect(resolved.meta.counts.decisions).toBeGreaterThanOrEqual(2);
    expect(resolved.meta.counts.facets).toBe(16);
    expect(resolved.meta.counts.specs).toBe(none.meta.counts.specs);
    expect(resolved.meta.truncated).toBe(false);
  });

  it("node ids are stable DB uuids across refetches (ac-4)", async () => {
    tagAc(AC(4));
    const a = await knowledgeGraph(memexId);
    const b = await knowledgeGraph(memexId);
    expect(a.nodes.decisions.map((d) => d.id)).toEqual(b.nodes.decisions.map((d) => d.id));
    expect(a.nodes.standards.map((s) => s.docId)).toEqual(b.nodes.standards.map((s) => s.docId));
  });
});

describe("empty states degrade to the same shape (ac-5)", () => {
  it("a memex with no vocabulary/ballots/drift returns empty arrays, not errors (ac-5, ac-6)", async () => {
    tagAc(AC(5));
    tagAc(AC(6)); // scope AC: integration tests cover the empty states end to end
    const bare = await makeTestMemex("kgbare");
    memexIds.push(bare);
    const g = await knowledgeGraph(bare);
    expect(g.nodes.facets).toEqual([]);
    expect(g.nodes.standards).toEqual([]);
    expect(g.nodes.specs).toEqual([]);
    expect(g.nodes.decisions).toEqual([]);
    expect(g.edges.standardFacet).toEqual([]);
    expect(g.edges.decisionFacet).toEqual([]);
    expect(g.edges.drift).toEqual([]);
    expect(g.meta.counts).toEqual({ facets: 0, standards: 0, specs: 0, decisions: 0 });
  });
});

describe("facet vocabulary is owner-resolved server-side (ac-3)", () => {
  it("a personal memex sees its OWN vocabulary (owner_type='memex'), not another tenant's (ac-3, ac-6)", async () => {
    tagAc(AC(3));
    tagAc(AC(6)); // scope AC: integration tests cover vocabulary-owner resolution
    const personal = await makePersonalTestMemex("kgpers");
    memexIds.push(personal);
    await seedDefaultFacetsForOwner({ ownerType: "memex", ownerId: personal });
    const g = await knowledgeGraph(personal);
    expect(g.nodes.facets.length).toBe(16);
  });
});

describe("shared extraction keeps standards-graph output intact (ac-12)", () => {
  it("standardsGraph still returns nodes/mentionEdges/semanticEdges (ac-12)", async () => {
    tagAc(AC(12));
    const sg = await standardsGraph(memexId);
    expect(sg).toHaveProperty("nodes");
    expect(sg).toHaveProperty("mentionEdges");
    expect(sg).toHaveProperty("semanticEdges");
    // Its standard node shape is UNCHANGED (no knowledge-graph-only fields leaked in).
    const node = sg.nodes.find((n: { docId: string }) => n.docId === standardDocId)!;
    expect(Object.keys(node).sort()).toEqual(["clauseCount", "docId", "handle", "title"]);
  });
});

describe("route: GET /analytics/knowledge-graph (ac-11, ac-3)", () => {
  function withApexHost(init: RequestInit = {}): RequestInit {
    return { ...init, headers: { ...(init.headers ?? {}), Host: "memex.ai" } };
  }

  it("serves the payload on a public memex and validates params (ac-11)", async () => {
    tagAc(AC(11));
    const m = await makeTestMemexWithDevAdmin("kgroute");
    memexIds.push(m.memexId);
    const path = `/api/${m.slug}/main`;

    const ok = await app.request(`${path}/analytics/knowledge-graph`, withApexHost());
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { nodes: unknown; edges: unknown; meta: { decisionFilter: string } };
    expect(body).toHaveProperty("nodes");
    expect(body).toHaveProperty("edges");
    expect(body.meta.decisionFilter).toBe("resolved");

    const withFilter = await app.request(`${path}/analytics/knowledge-graph?decisions=all`, withApexHost());
    expect(withFilter.status).toBe(200);

    const badFilter = await app.request(`${path}/analytics/knowledge-graph?decisions=bogus`, withApexHost());
    expect(badFilter.status).toBe(400);
    const badThreshold = await app.request(`${path}/analytics/knowledge-graph?semanticThreshold=9`, withApexHost());
    expect(badThreshold.status).toBe(400);
  });

  it("404s a private/unknown memex (std-7, ac-3)", async () => {
    tagAc(AC(3));
    const res = await app.request(`/api/no-such-ns/no-such-mx/analytics/knowledge-graph`, withApexHost());
    expect(res.status).toBe(404);
  });
});
