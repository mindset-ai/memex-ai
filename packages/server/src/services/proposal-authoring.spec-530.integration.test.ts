// spec-530 t-2 (dec-1) — proposeStandardChange authors at the clause grain.
//
// The caller names WHICH clauses change and WHAT they should say. The server derives the
// section from those clauses, refuses a set that spans more than one, and captures each
// target's current body as the authoring-time "before" — the evidence dec-3's staleness
// guard compares against at accept time. The caller never supplies the "before": a caller
// who could would be able to forge agreement with a clause they never read.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, docComments, standardClauses } from "../db/schema.js";
import { createStandard, proposeStandardChange, parseProposedChangeBody } from "./standards.js";
import { addClausesToSection } from "./clauses.js";
import { makeTestMemex } from "./test-helpers.js";
import { ValidationError } from "../types/errors.js";
import { tagAc } from "@memex-ai-ac/vitest";

const AC_8 = "mindset-prod/memex-building-itself/specs/spec-530/acs/ac-8";

const createdDocIds: string[] = [];
let memexId: string;

beforeAll(async () => {
  memexId = await makeTestMemex("s530prop");
});

afterAll(async () => {
  if (createdDocIds.length) {
    await db.delete(documents).where(inArray(documents.id, createdDocIds)).catch(() => {});
  }
});

/** A standard with TWO clause-bearing sections, so cross-section sets are expressible. */
async function twoSectionStandard() {
  const std = await createStandard(memexId, {
    title: "Spec530 Proposal Authoring",
    sections: [
      { sectionType: "rule", content: "" },
      { sectionType: "examples", content: "" },
    ],
  });
  createdDocIds.push(std.id);
  const ruleSection = std.sections.find((s) => s.sectionType === "rule")!;
  const exampleSection = std.sections.find((s) => s.sectionType === "examples")!;

  const ruleClauses = await addClausesToSection(memexId, ruleSection.id, [
    { body: "Cache reads through.", facets: [] },
    { body: "Never cache mutations.", facets: [] },
  ]);
  const exampleClauses = await addClausesToSection(memexId, exampleSection.id, [
    { body: "Correct: GET /things is cached.", facets: [] },
  ]);

  return { std, ruleSection, exampleSection, ruleClauses, exampleClauses };
}

async function commentsOn(docId: string) {
  return db.query.docComments.findMany({ where: eq(docComments.docId, docId) });
}

describe("spec-530 t-2: proposeStandardChange at the clause grain", () => {
  it("lands a clause-scoped proposal on the section its clauses belong to", async () => {
    tagAc(AC_8);
    const { std, ruleSection, ruleClauses } = await twoSectionStandard();

    const result = await proposeStandardChange(
      memexId,
      [{ op: "edit", clauseId: ruleClauses[0].id, after: "Cache reads through, always." }],
      "the rule drifted",
    );

    expect(result.comment.commentType).toBe("plan_revision");
    expect(result.comment.sectionId).toBe(ruleSection.id);
    expect(result.section.id).toBe(ruleSection.id);
    expect(result.standard.id).toBe(std.id);
  });

  it("captures the BEFORE from the live clause — the caller never supplies it", async () => {
    tagAc(AC_8);
    const { ruleClauses } = await twoSectionStandard();

    const result = await proposeStandardChange(memexId, [
      { op: "edit", clauseId: ruleClauses[0].id, after: "Cache reads through, always." },
    ]);

    const parsed = parseProposedChangeBody(result.comment.content);
    expect(parsed?.kind).toBe("clause-ops");
    if (parsed?.kind !== "clause-ops") return;
    expect(parsed.operations).toEqual([
      {
        op: "edit",
        // Addressed by handle, never by position [per std-10].
        clause: `cl-${ruleClauses[0].seq}`,
        // Read by the SERVER from the live row at authoring time.
        before: "Cache reads through.",
        after: "Cache reads through, always.",
      },
    ]);
  });

  it("carries a mixed add/edit/delete set in the authored order", async () => {
    tagAc(AC_8);
    const { ruleClauses } = await twoSectionStandard();

    const result = await proposeStandardChange(memexId, [
      { op: "delete", clauseId: ruleClauses[1].id },
      {
        op: "add",
        anchorClauseId: ruleClauses[0].id,
        placement: "after",
        body: "Caching is per-tenant.",
      },
      { op: "edit", clauseId: ruleClauses[0].id, after: "Cache reads through, always." },
    ]);

    const parsed = parseProposedChangeBody(result.comment.content);
    if (parsed?.kind !== "clause-ops") throw new Error("expected clause-ops");
    expect(parsed.operations.map((o) => o.op)).toEqual(["delete", "add", "edit"]);
    expect(parsed.operations[0]).toEqual({
      op: "delete",
      clause: `cl-${ruleClauses[1].seq}`,
      before: "Never cache mutations.",
    });
    // An `add` has no before — there is nothing there yet; it names its anchor.
    expect(parsed.operations[1]).toEqual({
      op: "add",
      anchor: `cl-${ruleClauses[0].seq}`,
      placement: "after",
      body: "Caching is per-tenant.",
    });
  });

  it("refuses a set spanning two sections, and writes nothing (ac-8)", async () => {
    tagAc(AC_8);
    const { std, ruleClauses, exampleClauses } = await twoSectionStandard();
    const before = (await commentsOn(std.id)).length;

    await expect(
      proposeStandardChange(memexId, [
        { op: "edit", clauseId: ruleClauses[0].id, after: "one section" },
        { op: "edit", clauseId: exampleClauses[0].id, after: "another section" },
      ]),
    ).rejects.toBeInstanceOf(ValidationError);

    // Nothing written: a rejected proposal must not leave a partial comment behind.
    expect((await commentsOn(std.id)).length).toBe(before);
  });

  it("refuses an empty operation set", async () => {
    tagAc(AC_8);
    await twoSectionStandard();
    await expect(proposeStandardChange(memexId, [])).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses a clause from another memex — tenancy holds at the clause grain", async () => {
    tagAc(AC_8);
    const otherMemex = await makeTestMemex("s530other");
    const otherStd = await createStandard(otherMemex, {
      title: "Someone else's standard",
      sections: [{ sectionType: "rule", content: "" }],
    });
    createdDocIds.push(otherStd.id);
    const otherClauses = await addClausesToSection(
      otherMemex,
      otherStd.sections[0].id,
      [{ body: "Their rule.", facets: [] }],
    );

    await expect(
      proposeStandardChange(memexId, [
        { op: "edit", clauseId: otherClauses[0].id, after: "not yours to propose on" },
      ]),
    ).rejects.toThrow();
  });

  it("refuses a soft-deleted clause as a target", async () => {
    tagAc(AC_8);
    const { ruleClauses } = await twoSectionStandard();
    await db
      .update(standardClauses)
      .set({ status: "deleted" })
      .where(eq(standardClauses.id, ruleClauses[0].id));

    await expect(
      proposeStandardChange(memexId, [
        { op: "edit", clauseId: ruleClauses[0].id, after: "editing a dead clause" },
      ]),
    ).rejects.toThrow();
  });
});
