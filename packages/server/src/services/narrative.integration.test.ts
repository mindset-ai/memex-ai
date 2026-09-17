import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { db } from "../db/connection.js";
import { acs, documents, decisions, docSections } from "../db/schema.js";
import { tagAc } from "@memex-ai-ac/vitest";
import { createDocDraft } from "./documents.js";
import { createAc } from "./acs.js";
import {
  proposeAcSupersession,
  acceptAcSupersession,
} from "./ac-supersession.js";
import { createDecision, resolveDecision } from "./decisions.js";
import { updateSection } from "./sections.js";
import {
  assessNarrativeFreshness,
  markNarrativeConsolidated,
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
