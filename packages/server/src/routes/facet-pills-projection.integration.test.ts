// spec-423 t-8 — the doc-read routes (GET /docs/:id, /decisions/doc, /tasks/doc) must
// project each task/decision's cast facet keys so the UI renders pills. Reproduces the
// exact seed-facet-scenario flow and asserts facetKeys reaches the route response.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { decisionFacetBallots } from "../db/schema.js";
import { makeTestMemexWithDevAdmin } from "../services/test-helpers.js";
import { ownerForMemex } from "../services/shared/memex-ownership.js";
import { seedDefaultFacetsForOwner } from "../services/default-facets.js";
import { vocabForMemex } from "../services/facet-vocab.js";
import { createDocDraft, updateDocStatus } from "../services/documents.js";
import { createTask } from "../services/tasks.js";
import { createDecision } from "../services/decisions.js";
import { castTaskBallot, castDecisionBallot, facetKeysByDecision } from "../services/facet-ballot.js";
import { updateMemexVisibility } from "../services/memexes.js";

let slug: string;
let handle: string;
let decisionId: string;
let chosen: string;
let testMemexId: string;

beforeAll(async () => {
  const { memexId, slug: nsSlug } = await makeTestMemexWithDevAdmin("fpp");
  testMemexId = memexId;
  slug = nsSlug;
  // Make it public so the anonymous app.request reads succeed (the route's auth is
  // not what's under test here — the facetKeys projection is). Reverted in afterAll so
  // it doesn't pollute the per-worker "all memexes are private" invariant (spec-111).
  await updateMemexVisibility(memexId, "public");
  const owner = await ownerForMemex(memexId);
  await seedDefaultFacetsForOwner(owner!);
  const vocab = await vocabForMemex(memexId);
  chosen = vocab[0].key;
  const verdict: Record<string, boolean> = {};
  for (const f of vocab) verdict[f.key] = f.key === chosen;
  const ballot = { verdict, none: false };

  const spec = await createDocDraft(memexId, "Facet Pills Spec", "Seeded.", "spec", undefined, undefined);
  handle = spec.handle;
  await updateDocStatus(memexId, spec.id, "build", { source: "rest" });
  const task = await createTask(memexId, spec.id, "Harden auth", "desc", undefined, undefined, {});
  await castTaskBallot(memexId, spec.id, task.id, ballot, {});
  const decision = await createDecision(memexId, spec.id, "A balloted decision", undefined, "human");
  decisionId = decision.id;
  await castDecisionBallot(memexId, spec.id, decision.id, ballot, {});
});

afterAll(async () => {
  // Restore the private default so the shared per-worker DB keeps the spec-111
  // "every memexes row is private" invariant.
  if (testMemexId) await updateMemexVisibility(testMemexId, "private").catch(() => {});
});

describe("facet-pills projection through the doc-read route (spec-423 t-8)", () => {
  it("the decision ballot row is stored and facetKeysByDecision returns the chosen key", async () => {
    const rows = await db.select().from(decisionFacetBallots).where(eq(decisionFacetBallots.decisionId, decisionId));
    expect(rows).toHaveLength(1); // the seed actually stored a ballot
    const map = await facetKeysByDecision(rows[0].memexId, [decisionId]);
    expect(map.get(decisionId)).toEqual([chosen]);
  });

  it("GET /docs/:id returns decisions + tasks each carrying facetKeys (ac-15)", async () => {
    const { app } = await import("../app.js");
    const res = await app.request(`/api/${slug}/main/docs/${handle}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      decisions: Array<{ title: string; facetKeys?: string[] }>;
      tasks: Array<{ title: string; facetKeys?: string[] }>;
    };
    expect(body.decisions[0]?.facetKeys).toContain(chosen);
    expect(body.tasks[0]?.facetKeys).toContain(chosen);
  });

  it("GET /decisions/doc/:docId returns facetKeys on each decision (the panel's endpoint)", async () => {
    const { app } = await import("../app.js");
    // Resolve the docId from the docs read so we hit the panel's exact endpoint.
    const docRes = await app.request(`/api/${slug}/main/docs/${handle}`);
    const doc = (await docRes.json()) as { id: string };
    const res = await app.request(`/api/${slug}/main/decisions/doc/${doc.id}`);
    expect(res.status).toBe(200);
    const decisions = (await res.json()) as Array<{ facetKeys?: string[] }>;
    expect(decisions[0]?.facetKeys).toContain(chosen);
  });
});
