// spec-179 t-4 — the standards-graph endpoint against a real DB.
//
// Mention edges come exclusively from clause_refs joins (ac-11 — no prose
// parsing at request time: the test writes clauses through the service, which
// materializes refs, then reads the graph). Semantic edges come from
// hand-planted section embeddings (ac-13, server half).

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { inArray, eq } from "drizzle-orm";

vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = "";
  return undefined;
});

import { sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, memexes, namespaces } from "../db/schema.js";
import { app } from "../app.js";
import { makeTestMemexWithDevAdmin } from "../services/test-helpers.js";
import { addSection } from "../services/sections.js";
import { createClause } from "../services/clauses.js";

const AC_GRAPH = "mindset-prod/memex-building-itself/specs/spec-179/acs/ac-11";
const AC_SEMANTIC = "mindset-prod/memex-building-itself/specs/spec-179/acs/ac-13";

let memexId: string;
let path: string;
const memexIds: string[] = [];

let std9: string;
let std2: string;
let std7: string;
let std2SectionId: string;
let std7SectionId: string;
let std9SectionId: string;

function withApexHost(init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers ?? {}), Host: "memex.ai" } };
}

async function seedStandard(handle: string): Promise<{ docId: string; sectionId: string }> {
  const [doc] = await db
    .insert(documents)
    .values({ memexId, handle, title: `Standard ${handle}`, docType: "standard" })
    .returning();
  const section = await addSection(memexId, doc.id, "rule", "Rule prose.");
  return { docId: doc.id, sectionId: section.id };
}

// A deterministic unit vector for the pgvector column: 1 at `hot`, 0 elsewhere.
// Identical hot index → cosine similarity 1; different → 0.
function unitVector(hot: number): string {
  const v = new Array(1536).fill(0);
  v[hot] = 1;
  return `[${v.join(",")}]`;
}

async function plantEmbedding(sectionId: string, hot: number): Promise<void> {
  await db.execute(
    sql`UPDATE doc_sections SET embedding = ${unitVector(hot)}::vector WHERE id = ${sectionId}`,
  );
}

beforeAll(async () => {
  const m = await makeTestMemexWithDevAdmin("stdgraph");
  memexId = m.memexId;
  path = `/api/${m.slug}/main`;
  memexIds.push(memexId);

  ({ docId: std2, sectionId: std2SectionId } = await seedStandard("std-2"));
  ({ docId: std7, sectionId: std7SectionId } = await seedStandard("std-7"));
  ({ docId: std9, sectionId: std9SectionId } = await seedStandard("std-9"));

  // A spec citing std-2 — must contribute NO edge (graph is standards-only).
  const [spec] = await db
    .insert(documents)
    .values({ memexId, handle: "spec-1", title: "A spec", docType: "spec" })
    .returning();
  const specSection = await addSection(memexId, spec.id, "rule", "Spec prose.");
  await createClause(memexId, specSection.id, "- The spec cites std-2.\n");

  // std-9 cites std-2 twice (two clauses) and std-7 once; also cites itself
  // (self-edge must be dropped) and spec-1 (non-standard target dropped).
  await createClause(memexId, std9SectionId, "- Pairs with std-2 (routing).\n");
  await createClause(memexId, std9SectionId, "- std-2 forbids subdomain tenant routing.\n");
  await createClause(memexId, std9SectionId, "- Unauthorized access returns 404 per std-7; see std-9 itself and spec-1.\n");

  // Semantic overlay: std-2 and std-7 share a hot index (similarity 1.0);
  // std-9 is orthogonal to both (similarity 0 — below any sane threshold).
  await plantEmbedding(std2SectionId, 3);
  await plantEmbedding(std7SectionId, 3);
  await plantEmbedding(std9SectionId, 7);
});

afterAll(async () => {
  const rows = await db.select().from(memexes).where(inArray(memexes.id, memexIds));
  await db.delete(namespaces).where(
    inArray(
      namespaces.id,
      rows.map((m) => m.namespaceId),
    ),
  );
});

describe("GET /analytics/standards-graph", () => {
  it("returns standard nodes and clause_refs-derived mention edges with evidence (ac-11)", async () => {
    tagAc(AC_GRAPH);
    const res = await app.request(`${path}/analytics/standards-graph`, withApexHost());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      nodes: Array<{ docId: string; handle: string; clauseCount: number }>;
      mentionEdges: Array<{
        sourceDocId: string;
        targetDocId: string;
        count: number;
        evidence: Array<{ clauseSeq: number | null; snippet: string | null }>;
      }>;
    };

    // Nodes: the three standards, never the spec.
    expect(body.nodes.map((n) => n.handle)).toEqual(["std-2", "std-7", "std-9"]);
    const std9Node = body.nodes.find((n) => n.handle === "std-9")!;
    expect(std9Node.clauseCount).toBe(3);

    // Edges: std-9 → std-2 (weight 2, evidence carries citing clause seqs +
    // snippets), std-9 → std-7 (weight 1). No self-edge, no spec edges.
    expect(body.mentionEdges).toHaveLength(2);
    const toStd2 = body.mentionEdges.find((e) => e.targetDocId === std2)!;
    expect(toStd2).toMatchObject({ sourceDocId: std9, count: 2 });
    expect(toStd2.evidence).toHaveLength(2);
    expect(toStd2.evidence[0].snippet).toContain("std-2");
    expect(toStd2.evidence.every((e) => typeof e.clauseSeq === "number")).toBe(true);

    const toStd7 = body.mentionEdges.find((e) => e.targetDocId === std7)!;
    expect(toStd7).toMatchObject({ sourceDocId: std9, count: 1 });

    expect(body.mentionEdges.some((e) => e.sourceDocId === e.targetDocId)).toBe(false);
  });

  it("returns semantic edges above the threshold from section embeddings (ac-13)", async () => {
    tagAc(AC_SEMANTIC);
    const res = await app.request(`${path}/analytics/standards-graph`, withApexHost());
    const body = (await res.json()) as {
      semanticEdges: Array<{ sourceDocId: string; targetDocId: string; similarity: number }>;
    };

    // Exactly one pair clears the default 0.5 floor: std-2 ↔ std-7 at 1.0.
    expect(body.semanticEdges).toHaveLength(1);
    const edge = body.semanticEdges[0];
    expect([edge.sourceDocId, edge.targetDocId].sort()).toEqual([std2, std7].sort());
    expect(edge.similarity).toBe(1);
  });

  it("threshold is adjustable and validated", async () => {
    tagAc(AC_SEMANTIC);
    // Floor 0 → orthogonal pairs (similarity 0) now appear too.
    const res = await app.request(
      `${path}/analytics/standards-graph?semanticThreshold=0`,
      withApexHost(),
    );
    const body = (await res.json()) as { semanticEdges: unknown[] };
    expect(body.semanticEdges).toHaveLength(3); // all three doc pairs

    const bad = await app.request(
      `${path}/analytics/standards-graph?semanticThreshold=2`,
      withApexHost(),
    );
    expect(bad.status).toBe(400);
  });
});
