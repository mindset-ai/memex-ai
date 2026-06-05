// Integration tests for listResolvedDecisionImplAcCoverage — the helper
// that powers both the list_acs decision-coverage line and the
// assess_brief({target:'build'}) decision-AC-coverage rubric check.
//
// DB-backed because the helper joins ac_parent_links ↔ acs ↔ decisions with
// three filter clauses (parent_kind='decision', ac.kind='implementation',
// ac.status='active'). Any one of those clauses going wrong silently
// changes the rule's shape — a unit test on a mocked DB would pass.

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, acs, decisions } from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import { createDecision, resolveDecision } from "./decisions.js";
import {
  createAc,
  rejectAc,
  listResolvedDecisionImplAcCoverage,
} from "./acs.js";
import { makeTestMemex } from "./test-helpers.js";

const createdDocIds: string[] = [];

afterAll(async () => {
  for (const id of createdDocIds) {
    await db.delete(acs).where(eq(acs.briefId, id)).catch(() => {});
    await db.delete(decisions).where(eq(decisions.docId, id)).catch(() => {});
    await db.delete(documents).where(eq(documents.id, id)).catch(() => {});
  }
});

let memexId: string;

beforeAll(async () => {
  memexId = await makeTestMemex("dec-need-acs");
});

async function seedBrief(): Promise<{ id: string; handle: string }> {
  const doc = await createDocDraft(memexId, "decisions-need-acs test", "purpose", "spec");
  createdDocIds.push(doc.id);
  return { id: doc.id, handle: doc.handle! };
}

describe("listResolvedDecisionImplAcCoverage", () => {
  it("returns empty when the Spec has no resolved decisions", async () => {
    const spec = await seedBrief();
    const out = await listResolvedDecisionImplAcCoverage(memexId, spec.id);
    expect(out).toEqual([]);
  });

  it("excludes open decisions — only resolved decisions appear", async () => {
    const spec = await seedBrief();
    await createDecision(memexId, spec.id, "Open decision");
    const out = await listResolvedDecisionImplAcCoverage(memexId, spec.id);
    expect(out).toEqual([]);
  });

  it("returns count=0 for a resolved decision with zero implementation ACs (NAKED)", async () => {
    const spec = await seedBrief();
    const d = await createDecision(memexId, spec.id, "Naked decision");
    await resolveDecision(memexId, d.id, "resolved");

    const out = await listResolvedDecisionImplAcCoverage(memexId, spec.id);
    expect(out).toHaveLength(1);
    expect(out[0].implementationAcCount).toBe(0);
    expect(out[0].decisionTitle).toBe("Naked decision");
  });

  it("counts a linked implementation AC against its decision", async () => {
    const spec = await seedBrief();
    const d = await createDecision(memexId, spec.id, "Decision with one impl AC");
    await resolveDecision(memexId, d.id, "resolved");
    await createAc({
      memexId,
      briefId: spec.id,
      kind: "implementation",
      statement: "first impl AC",
      parent: { kind: "decision", id: d.id },
    });
    const out = await listResolvedDecisionImplAcCoverage(memexId, spec.id);
    expect(out).toHaveLength(1);
    expect(out[0].implementationAcCount).toBe(1);
  });

  it("excludes scope ACs even when they're linked to a decision", async () => {
    const spec = await seedBrief();
    const d = await createDecision(memexId, spec.id, "Decision with a scope AC");
    await resolveDecision(memexId, d.id, "resolved");
    // Author a scope AC linked to the decision — should NOT count toward
    // implementation-AC coverage. Scope ACs satisfy a different rule.
    await createAc({
      memexId,
      briefId: spec.id,
      kind: "scope",
      statement: "scope AC linked to decision",
      parent: { kind: "decision", id: d.id },
    });
    const out = await listResolvedDecisionImplAcCoverage(memexId, spec.id);
    expect(out[0].implementationAcCount).toBe(0);
  });

  it("excludes rejected implementation ACs", async () => {
    const spec = await seedBrief();
    const d = await createDecision(memexId, spec.id, "Decision with a rejected AC");
    await resolveDecision(memexId, d.id, "resolved");
    const ac = await createAc({
      memexId,
      briefId: spec.id,
      kind: "implementation",
      statement: "later rejected",
      parent: { kind: "decision", id: d.id },
    });
    await rejectAc(memexId, ac.id);
    const out = await listResolvedDecisionImplAcCoverage(memexId, spec.id);
    expect(out[0].implementationAcCount).toBe(0);
  });

  it("counts multiple implementation ACs per decision", async () => {
    const spec = await seedBrief();
    const d = await createDecision(memexId, spec.id, "Decision with three impl ACs");
    await resolveDecision(memexId, d.id, "resolved");
    for (let i = 0; i < 3; i++) {
      await createAc({
        memexId,
        briefId: spec.id,
        kind: "implementation",
        statement: `impl AC ${i}`,
        parent: { kind: "decision", id: d.id },
      });
    }
    const out = await listResolvedDecisionImplAcCoverage(memexId, spec.id);
    expect(out[0].implementationAcCount).toBe(3);
  });

  it("returns one row per resolved decision, ordered by seq", async () => {
    const spec = await seedBrief();
    const d1 = await createDecision(memexId, spec.id, "First (naked)");
    const d2 = await createDecision(memexId, spec.id, "Second (covered)");
    const d3 = await createDecision(memexId, spec.id, "Third (naked)");
    await resolveDecision(memexId, d1.id, "r");
    await resolveDecision(memexId, d2.id, "r");
    await resolveDecision(memexId, d3.id, "r");
    await createAc({
      memexId,
      briefId: spec.id,
      kind: "implementation",
      statement: "AC for d2",
      parent: { kind: "decision", id: d2.id },
    });

    const out = await listResolvedDecisionImplAcCoverage(memexId, spec.id);
    expect(out).toHaveLength(3);
    // Ordered by seq ascending — first decision created first.
    expect(out[0].decisionTitle).toBe("First (naked)");
    expect(out[0].implementationAcCount).toBe(0);
    expect(out[1].decisionTitle).toBe("Second (covered)");
    expect(out[1].implementationAcCount).toBe(1);
    expect(out[2].decisionTitle).toBe("Third (naked)");
    expect(out[2].implementationAcCount).toBe(0);
  });

  it("only counts an implementation AC against decisions when linked via parent_kind='decision'", async () => {
    // Implementation AC with no parent link at all should not increase any
    // decision's count. (Edge case: a free-floating implementation AC.)
    const spec = await seedBrief();
    const d = await createDecision(memexId, spec.id, "Decision with no linked AC");
    await resolveDecision(memexId, d.id, "resolved");
    await createAc({
      memexId,
      briefId: spec.id,
      kind: "implementation",
      statement: "unlinked impl AC",
      // No `parent` — AC exists but is not linked to any decision.
    });
    const out = await listResolvedDecisionImplAcCoverage(memexId, spec.id);
    expect(out[0].implementationAcCount).toBe(0);
  });
});
