// spec-423 t-5 — the forced ballot + payoff readout wired into the create_task and
// resolve_decision tool handlers (dec-5/dec-6). End-to-end through executeServerTool
// against a seeded facet vocabulary + a facet-tagged standard.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { and, eq, inArray } from "drizzle-orm";
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
  decisions,
  taskFacetBallots,
  decisionFacetBallots,
  facetRoutingLog,
} from "../db/schema.js";
import { executeServerTool } from "./tools.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-423";
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;

let userId: string;
let memexId: string;
let nsSlug: string;
let specRef: string;
let decisionId: string;
const facetId = new Map<string, string>();

beforeAll(async () => {
  const sub = `t5-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
  const [u] = await db.insert(users).values({ email: `${sub}@memex.ai` } as never).returning();
  userId = u.id;
  const [ns] = await db.insert(namespaces).values({ slug: sub, kind: "org" }).returning();
  nsSlug = ns.slug;
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: `Test ${sub}` }).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [mx] = await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name: "Main" }).returning();
  memexId = mx.id;
  await db.insert(orgMemberships).values({ userId, orgId: org.id, role: "administrator" });

  // Seed a two-facet vocabulary for the org owner.
  for (const key of ["xc-security", "xc-perf"]) {
    const [f] = await db.insert(facets).values({ ownerType: "org", ownerId: org.id, key, description: key }).returning();
    facetId.set(key, f.id);
  }

  // A standard whose clause governs xc-security → routing surfaces it.
  const [std] = await db
    .insert(documents)
    .values({ memexId, handle: "std-1", title: "Auth guard standard", docType: "standard", status: "approved" })
    .returning();
  const [sec] = await db
    .insert(docSections)
    .values({ docId: std.id, sectionType: "rule", content: "Unauthorized access returns 404.", seq: 1, position: 1 })
    .returning();
  const [cl] = await db
    .insert(standardClauses)
    .values({ memexId, docId: std.id, sectionId: sec.id, seq: 1, position: 1, body: "404 not 403" })
    .returning();
  await db.insert(standardClauseFacets).values({ memexId, clauseId: cl.id, facetId: facetId.get("xc-security")! });

  // A spec in BUILD (so create_task is allowed) + a decision to resolve.
  const [spec] = await db
    .insert(documents)
    .values({ memexId, handle: "spec-1", title: "Consumer spec", docType: "spec", status: "build" })
    .returning();
  specRef = `${nsSlug}/main/specs/spec-1`;
  const [dec] = await db.insert(decisions).values({ memexId, docId: spec.id, seq: 1, title: "A decision", status: "open" }).returning();
  decisionId = dec.id;
});

afterAll(async () => {
  await db.delete(documents).where(eq(documents.memexId, memexId)).catch(() => {});
  await db.delete(memexes).where(eq(memexes.id, memexId)).catch(() => {});
  await db.delete(users).where(eq(users.id, userId)).catch(() => {});
});

const fullBallot = { verdict: { "xc-security": true, "xc-perf": false }, none: false };

describe("create_task forces a ballot and hands back the governing standards (spec-423 t-5, dec-5)", () => {
  it("rejects a missing/incomplete ballot with the vocabulary re-handed (ac-13)", async () => {
    tagAc(AC(13));
    await expect(
      executeServerTool(memexId, "create_task", { ref: specRef, title: "no ballot", description: "x" }, userId),
    ).rejects.toThrow(/xc-security/);
    await expect(
      executeServerTool(
        memexId,
        "create_task",
        { ref: specRef, title: "partial", description: "x", facetBallot: { verdict: { "xc-security": true }, none: false } },
        userId,
      ),
    ).rejects.toThrow(/xc-perf/);
  });

  it("accepts a complete ballot, stores it, and appends the ranked top-K readout (ac-13)", async () => {
    tagAc(AC(13));
    const out = await executeServerTool(
      memexId,
      "create_task",
      { ref: specRef, title: "Build the auth guard", description: "harden authz", facetBallot: fullBallot },
      userId,
    );
    // The payoff readout names the governing standard.
    expect(out).toContain("std-1");
    // The ballot landed.
    const ballots = await db.select().from(taskFacetBallots).where(eq(taskFacetBallots.memexId, memexId));
    expect(ballots).toHaveLength(1);
    expect(ballots[0].verdict).toEqual({ "xc-security": true, "xc-perf": false });
    // The routing decision was logged (dec-4) on the task hook.
    const logs = await db.select().from(facetRoutingLog).where(and(eq(facetRoutingLog.memexId, memexId), eq(facetRoutingLog.noun, "task")));
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0].candidates.some((c) => c.handle === "std-1")).toBe(true);
  });
});

describe("resolve_decision forces a ballot and stores it work-side (spec-423 t-5, dec-6)", () => {
  it("rejects a missing ballot, then accepts a complete one and stores it in decision_facet_ballots (ac-14)", async () => {
    tagAc(AC(14));
    const decRef = `${nsSlug}/main/specs/spec-1/decisions/dec-1`;
    await expect(
      executeServerTool(memexId, "resolve_decision", { ref: decRef, resolution: "done" }, userId),
    ).rejects.toThrow(/xc-security/);

    const out = await executeServerTool(
      memexId,
      "resolve_decision",
      { ref: decRef, resolution: "go with the guard", facetBallot: fullBallot },
      userId,
    );
    expect(out).toContain("std-1"); // payoff readout on the decision hook too
    const ballots = await db.select().from(decisionFacetBallots).where(eq(decisionFacetBallots.decisionId, decisionId));
    expect(ballots).toHaveLength(1);
    expect(ballots[0].verdict).toEqual({ "xc-security": true, "xc-perf": false });
  });
});
