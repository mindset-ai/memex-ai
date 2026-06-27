// spec-340 t-6 (dec-9) — the verb-dispatched `facets` tool (v0: list), resolved via
// the polymorphic owner. Tags ac-40.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/connection.js";
import { namespaces, memexes, facets } from "../../db/schema.js";
import { makeTestMemex, makePersonalTestMemex } from "../../services/test-helpers.js";
import { seedDefaultFacetsForOwner } from "../../services/default-facets.js";
import { listFacetsForMemex } from "../../services/facet-vocab.js";
import { facetsTools } from "./facets.js";
import { toolSpecs } from "../tool-specs.js";
import type { ToolCtx } from "./shared.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-340";
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;

let orgMemexId: string;
let orgId: string;
let personalMemexId: string;

beforeAll(async () => {
  orgMemexId = await makeTestMemex("ffac");
  const [row] = await db
    .select({ orgId: namespaces.ownerOrgId })
    .from(memexes)
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(memexes.id, orgMemexId))
    .limit(1);
  orgId = row!.orgId!;
  await seedDefaultFacetsForOwner({ ownerType: "org", ownerId: orgId });

  personalMemexId = await makePersonalTestMemex("ffacp");
  await seedDefaultFacetsForOwner({ ownerType: "memex", ownerId: personalMemexId });
});

afterAll(async () => {
  await db.delete(facets).where(and(eq(facets.ownerType, "org"), eq(facets.ownerId, orgId))).catch(() => {});
  await db.delete(facets).where(and(eq(facets.ownerType, "memex"), eq(facets.ownerId, personalMemexId))).catch(() => {});
});

describe("the verb-dispatched facets tool (spec-340 t-6)", () => {
  it("is exactly ONE verb-dispatched tool; no per-operation facet tools exist (ac-40)", () => {
    tagAc(AC(40));
    const names = toolSpecs.map((t) => t.name);
    expect(names.filter((n) => /facet/i.test(n))).toEqual(["facets"]);
    for (const banned of ["list_facets", "add_facet", "edit_facet", "delete_facet"]) {
      expect(names).not.toContain(banned);
    }
    expect(Object.keys(facetsTools[0].schema)).toContain("verb");
    expect(facetsTools[0].annotations.readOnlyHint).toBe(true);
  });

  it("verb 'list' returns the owner's vocabulary, resolved via owner_type/owner_id (ac-40)", async () => {
    tagAc(AC(40));
    // org-owned memex → resolves to the org owner
    const orgVocab = await listFacetsForMemex(orgMemexId);
    expect(orgVocab.length).toBe(16);
    expect(orgVocab.every((f) => f.key && f.description)).toBe(true);
    const ords = orgVocab.map((f) => f.ord);
    expect(ords).toEqual([...ords].sort((a, b) => a - b));

    const ctx = { resolveMemex: async () => orgMemexId } as unknown as ToolCtx;
    const out = (await facetsTools[0].handler({ verb: "list" }, ctx)) as string;
    expect(out).toContain("Facet vocabulary");
    expect(out).toContain("security");
    expect(out).toContain("db-migrations");

    // personal memex → resolves to the memex owner (dec-7), returns ITS own vocabulary
    const personalVocab = await listFacetsForMemex(personalMemexId);
    expect(personalVocab.length).toBe(16);
    const pctx = { resolveMemex: async () => personalMemexId } as unknown as ToolCtx;
    const pout = (await facetsTools[0].handler({ verb: "list" }, pctx)) as string;
    expect(pout).toContain("Facet vocabulary");
  });
});
