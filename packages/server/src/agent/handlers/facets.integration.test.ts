// spec-340 t-13 — the verb-dispatched `facets` tool (v0: list).

import { describe, it, expect, beforeAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { eq } from "drizzle-orm";
import { db } from "../../db/connection.js";
import { namespaces, memexes } from "../../db/schema.js";
import { makeTestMemex } from "../../services/test-helpers.js";
import { seedDefaultFacets } from "../../services/default-facets.js";
import { listOrgFacets } from "../../services/facet-classifier.js";
import { facetsTools } from "./facets.js";
import { toolSpecs } from "../tool-specs.js";
import type { ToolCtx } from "./shared.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-340/acs/ac-${n}`;

let memexId: string;

beforeAll(async () => {
  memexId = await makeTestMemex("ffac");
  const [row] = await db
    .select({ orgId: namespaces.ownerOrgId })
    .from(memexes)
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(memexes.id, memexId))
    .limit(1);
  await seedDefaultFacets(row!.orgId!);
});

describe("the verb-dispatched facets tool (spec-340 t-13)", () => {
  it("is exactly ONE verb-dispatched tool; no per-operation facet tools exist (ac-30)", () => {
    tagAc(AC(30));
    const names = toolSpecs.map((t) => t.name);
    // exactly one tool whose name mentions facet(s)
    expect(names.filter((n) => /facet/i.test(n))).toEqual(["facets"]);
    for (const banned of ["list_facets", "add_facet", "edit_facet", "delete_facet"]) {
      expect(names).not.toContain(banned);
    }
    // dispatched on a `verb` param
    expect(Object.keys(facetsTools[0].schema)).toContain("verb");
  });

  it("verb 'list' returns the org's vocabulary (key, name, description, ord) ordered by ord (ac-30)", async () => {
    tagAc(AC(30));
    const vocab = await listOrgFacets(memexId);
    expect(vocab.length).toBe(16);
    expect(vocab.every((f) => f.key && f.description)).toBe(true);
    const ords = vocab.map((f) => f.ord);
    expect(ords).toEqual([...ords].sort((a, b) => a - b));

    // exercise the tool handler with a stub ctx that resolves to our memex
    const ctx = { resolveMemex: async () => memexId } as unknown as ToolCtx;
    const out = (await facetsTools[0].handler({ verb: "list" }, ctx)) as string;
    expect(out).toContain("Facet vocabulary");
    expect(out).toContain("security");
    expect(out).toContain("db-migrations");
  });
});
