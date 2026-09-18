import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { db } from "../db/connection.js";
import { acs, documents, decisions } from "../db/schema.js";
import { tagAc } from "@memex-ai-ac/vitest";
import { createDocDraft } from "./documents.js";
import { createAc, setAcAcceptance } from "./acs.js";
import {
  proposeAcSupersession,
  acceptAcSupersession,
} from "./ac-supersession.js";
import { createDecision, resolveDecision } from "./decisions.js";
import { updateSection } from "./sections.js";
import {
  assessNarrativeFreshness,
  markNarrativeConsolidated,
  isSpecNarrativeStale,
} from "./narrative.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import { makeTestMemex } from "./test-helpers.js";

const createdDocIds: string[] = [];

afterAll(async () => {
  for (const id of createdDocIds) {
    await db.delete(decisions).where(eq(decisions.docId, id)).catch(() => {});
    await db.delete(documents).where(eq(documents.id, id)).catch(() => {});
  }
});

let memexId: string;
beforeAll(async () => {
  memexId = await makeTestMemex();
});

describe("assessNarrativeFreshness", () => {
  it("returns NotFoundError for unknown briefId", async () => {
    await expect(
      assessNarrativeFreshness(memexId, "00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow(NotFoundError);
  });

  it("rejects non-Spec docTypes", async () => {
    const doc = await createDocDraft(memexId, "Not a spec", "Purpose", "document");
    createdDocIds.push(doc.id);
    await expect(assessNarrativeFreshness(memexId, doc.id)).rejects.toThrow(
      ValidationError,
    );
  });

  it("treats never-consolidated as 'all changed'", async () => {
    const spec = await createDocDraft(memexId, "Never consolidated", "Purpose", "spec");
    createdDocIds.push(spec.id);
    const dec = await createDecision(memexId, spec.id, "Decide A");

    const result = await assessNarrativeFreshness(memexId, spec.id);
    expect(result.lastConsolidatedAt).toBeNull();
    expect(result.changedDecisions.length).toBe(1);
    expect(result.changedDecisions[0].handle).toBe(`dec-${dec.seq}`);
    // Overview section is created with the doc, so it shows as changed
    expect(result.changedSections.length).toBeGreaterThanOrEqual(1);
    expect(result.factSheet).toMatch(/never/);
  });

  it("returns no changes immediately after consolidation", async () => {
    const spec = await createDocDraft(memexId, "Just consolidated", "Purpose", "spec");
    createdDocIds.push(spec.id);
    await createDecision(memexId, spec.id, "Old decision");

    await markNarrativeConsolidated(memexId, spec.id);
    // Wait a tick so the change-comparison cutoff is strictly after the
    // existing rows' timestamps.
    await new Promise((r) => setTimeout(r, 5));

    const result = await assessNarrativeFreshness(memexId, spec.id);
    expect(result.lastConsolidatedAt).not.toBeNull();
    expect(result.changedDecisions).toEqual([]);
    expect(result.changedSections).toEqual([]);
    expect(result.factSheet).toMatch(/fresh/i);
  });

  it("flags decisions resolved after consolidation", async () => {
    const spec = await createDocDraft(memexId, "Decision after", "Purpose", "spec");
    createdDocIds.push(spec.id);
    const dec = await createDecision(memexId, spec.id, "Pick something");
    await markNarrativeConsolidated(memexId, spec.id);
    await new Promise((r) => setTimeout(r, 5));
    await resolveDecision(memexId, dec.id, "Picked it");

    const result = await assessNarrativeFreshness(memexId, spec.id);
    expect(result.changedDecisions.length).toBe(1);
    expect(result.changedDecisions[0].status).toBe("resolved");
  });

  it("flags sections updated after consolidation", async () => {
    const spec = await createDocDraft(memexId, "Section after", "Purpose", "spec");
    createdDocIds.push(spec.id);
    await markNarrativeConsolidated(memexId, spec.id);
    await new Promise((r) => setTimeout(r, 5));
    await updateSection(memexId, spec.sections[0].id, "Updated content");

    const result = await assessNarrativeFreshness(memexId, spec.id);
    expect(result.changedSections.length).toBe(1);
    expect(result.changedSections[0].sectionType).toBe(spec.sections[0].sectionType);
  });

  // spec-569 t-1 — the gap this Spec exists to close. Freshness reads
  // `decisions` and `doc_sections`; `acs` is never queried, so the one AC
  // mutation guaranteed to invalidate prose leaves the fact sheet asserting
  // the narrative is current. RED until the predicate reads criteria.
  it("flags criteria superseded after consolidation", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-569/acs/ac-5");

    const spec = await createDocDraft(memexId, "Criterion after", "Purpose", "spec");
    createdDocIds.push(spec.id);
    const ac = await createAc({
      memexId,
      briefId: spec.id,
      kind: "implementation",
      statement: "The exporter writes one row per invoice.",
    });
    const dec = await createDecision(memexId, spec.id, "Supersede under this");

    await markNarrativeConsolidated(memexId, spec.id);
    await new Promise((r) => setTimeout(r, 5));

    const proposed = await proposeAcSupersession(
      {
        memexId,
        acId: ac.id,
        decisionId: dec.id,
        proposedStatement: "The exporter writes one row per invoice LINE ITEM.",
      },
      { channel: "mcp" },
    );
    await acceptAcSupersession(memexId, proposed.comment.id, { channel: "mcp" });

    const result = await assessNarrativeFreshness(memexId, spec.id);

    // Preconditions — a red here is an environment fault, not the defect.
    expect(result.lastConsolidatedAt).not.toBeNull();
    const supersededRow = await db.query.acs.findFirst({ where: eq(acs.id, ac.id) });
    expect(supersededRow!.status).toBe("superseded");
    expect(supersededRow!.updatedAt.getTime()).toBeGreaterThan(
      result.lastConsolidatedAt!.getTime(),
    );

    // Vacuity guard: nothing OTHER than the criterion moved, so a "not fresh"
    // verdict can only have come from the supersession. Without this the
    // assertion below would pass on any unrelated decision or section edit.
    expect(result.changedDecisions).toEqual([]);
    expect(result.changedSections).toEqual([]);

    // The claim. Today this fails and `factSheet` reads, verbatim:
    // "Narrative is fresh - nothing has changed since the last consolidation."
    expect(result.factSheet).not.toMatch(/fresh/i);
  });

  // spec-569 t-4 / ac-9 — the fact sheet REPORTS every criterion that moved,
  // while the stale verdict stays driven by `superseded` / `rejected` alone.
  // Reporting a movement and declaring the narrative stale are two different
  // claims; conflating them is how the noise dec-1 excluded gets re-imported.
  it("reports a routine acceptance write without flipping the verdict", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-569/acs/ac-9");

    const spec = await createDocDraft(memexId, "Acceptance only", "Purpose", "spec");
    createdDocIds.push(spec.id);
    const ac = await createAc({
      memexId,
      briefId: spec.id,
      kind: "implementation",
      statement: "The exporter reconciles to the ledger.",
    });

    await markNarrativeConsolidated(memexId, spec.id);
    await new Promise((r) => setTimeout(r, 5));

    // The most ordinary act on the AC panel: a human marking it verified.
    await setAcAcceptance(memexId, ac.id, "a reviewer", { channel: "rest_ui" });

    const result = await assessNarrativeFreshness(memexId, spec.id);

    // Precondition — the write really did move the row, so the assertions
    // below are about classification and not about an inert fixture.
    expect(result.changedAcs).toHaveLength(1);
    expect(result.changedAcs[0].handle).toBe(`ac-${ac.seq}`);
    expect(result.changedAcs[0].status).toBe("active");

    // REPORTED: it moved, so the sheet may not claim freshness...
    expect(result.factSheet).not.toMatch(/Narrative is fresh/);
    expect(result.factSheet).toMatch(/none changed meaning/);

    // ...but NOT stale: the meaning did not change, so the verdict is untouched.
    expect(result.changedAcs[0].meaningChanged).toBe(false);
    expect(
      isSpecNarrativeStale(result.lastConsolidatedAt, [], [
        {
          id: ac.id,
          status: "active",
          updatedAt: result.changedAcs[0].updatedAt,
        },
      ]),
    ).toBe(false);
  });

  // spec-569 M3 (review round 1): the MIXED case. The fact sheet's per-criterion
  // sentence only fires when nothing else moved, so when a decision moves too
  // the agent reads "1 criterion touched (0 changed meaning)" and is told
  // nothing about WHICH. `changedAcs` has to carry the handle regardless —
  // the assess_spec handler renders it from there.
  it("carries the moved criterion's handle even when a decision moved too", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-569/acs/ac-9");

    const spec = await createDocDraft(memexId, "Mixed", "Purpose", "spec");
    createdDocIds.push(spec.id);
    const ac = await createAc({
      memexId,
      briefId: spec.id,
      kind: "implementation",
      statement: "One row per invoice.",
    });
    const dec = await createDecision(memexId, spec.id, "Something to resolve");

    await markNarrativeConsolidated(memexId, spec.id);
    await new Promise((r) => setTimeout(r, 5));

    // BOTH move: a decision resolves and the criterion takes a routine write.
    await resolveDecision(memexId, dec.id, "Resolved after consolidation");
    await setAcAcceptance(memexId, ac.id, "a reviewer", { channel: "rest_ui" });

    const result = await assessNarrativeFreshness(memexId, spec.id);

    // Vacuity guard: the mixed case is really mixed, or this tests nothing.
    expect(result.changedDecisions).toHaveLength(1);

    expect(result.changedAcs).toHaveLength(1);
    expect(result.changedAcs[0].handle).toBe(`ac-${ac.seq}`);
    expect(result.changedAcs[0].meaningChanged).toBe(false);

    // The narrative-verdict sentence is silent here (a decision moved), so the
    // handle is reachable ONLY through changedAcs.
    expect(result.factSheet).not.toMatch(/Criteria whose meaning changed/);
    expect(result.factSheet).not.toMatch(/none changed meaning/);
  });

  it("lists a superseded criterion as meaning-changed and says so", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-569/acs/ac-9");

    const spec = await createDocDraft(memexId, "Meaning changed", "Purpose", "spec");
    createdDocIds.push(spec.id);
    const ac = await createAc({
      memexId,
      briefId: spec.id,
      kind: "implementation",
      statement: "One row per invoice.",
    });
    const dec = await createDecision(memexId, spec.id, "Supersede under this");

    await markNarrativeConsolidated(memexId, spec.id);
    await new Promise((r) => setTimeout(r, 5));

    const proposed = await proposeAcSupersession(
      {
        memexId,
        acId: ac.id,
        decisionId: dec.id,
        proposedStatement: "One row per invoice LINE ITEM.",
      },
      { channel: "mcp" },
    );
    await acceptAcSupersession(memexId, proposed.comment.id, { channel: "mcp" });

    const result = await assessNarrativeFreshness(memexId, spec.id);

    const superseded = result.changedAcs.find((a) => a.status === "superseded");
    expect(superseded).toBeDefined();
    expect(superseded!.meaningChanged).toBe(true);

    // NOT /changed meaning/ — the count line emits "(N changed meaning)"
    // unconditionally, so that regex matches the FRESH sheet too and the
    // assertion could not fail. Caught by deleting the sentence arm and
    // watching this file stay 11/11 green. Anchor on the sentence itself.
    expect(result.factSheet).toMatch(/Criteria whose meaning changed/);
    expect(result.factSheet).toMatch(/false by construction/);
    expect(result.factSheet).not.toMatch(/Narrative is fresh/);
  });
});

describe("markNarrativeConsolidated", () => {
  it("rejects non-Spec docTypes", async () => {
    const doc = await createDocDraft(memexId, "Not a spec", "Purpose", "document");
    createdDocIds.push(doc.id);
    await expect(markNarrativeConsolidated(memexId, doc.id)).rejects.toThrow(
      ValidationError,
    );
  });

  it("stamps the column to a recent timestamp", async () => {
    const spec = await createDocDraft(memexId, "Stamp it", "Purpose", "spec");
    createdDocIds.push(spec.id);
    const before = Date.now();
    const result = await markNarrativeConsolidated(memexId, spec.id);
    const after = Date.now();

    expect(result.consolidatedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.consolidatedAt.getTime()).toBeLessThanOrEqual(after);

    // Verify the DB persisted it
    const [row] = await db
      .select()
      .from(documents)
      .where(and(eq(documents.id, spec.id), eq(documents.memexId, memexId)));
    expect(row.narrativeLastConsolidatedAt).not.toBeNull();
  });
});
