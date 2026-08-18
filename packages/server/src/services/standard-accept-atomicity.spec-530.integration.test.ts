// spec-530 t-4 (dec-4, ac-10) — the accept is all-or-nothing.
//
// This is the property the two-call, agent-orchestrated alternative could not hold, and
// dec-1 is what made it matter: a proposal is a SET, so "two calls" would have been
// "N+1 calls". An interruption partway would leave a Standard half-rewritten with its
// proposal still open — a state indistinguishable, to the next reader, from one not yet
// applied. One transaction removes that state rather than asking anyone to reason about it.
//
// Isolated in its own file because it mocks the clause-write module, and a module mock
// applies to every test in the file it lives in [per std-37: restore global stubs].

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { and, asc, eq, ne } from "drizzle-orm";

// The failure is injected at the clause-write seam: the SECOND body write in a run
// throws, standing in for any mid-transaction fault (a constraint violation, a dropped
// connection, a deploy restarting the process). What matters is not which fault it is,
// but that the operations already applied do not survive it.
let bodyWriteCalls = 0;
let failOnBodyWrite: number | null = null;

vi.mock("./clauses.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./clauses.js")>();
  return {
    ...actual,
    updateClauseBodyTx: async (
      ...args: Parameters<typeof actual.updateClauseBodyTx>
    ): ReturnType<typeof actual.updateClauseBodyTx> => {
      bodyWriteCalls += 1;
      if (failOnBodyWrite !== null && bodyWriteCalls === failOnBodyWrite) {
        throw new Error("injected mid-transaction fault");
      }
      return actual.updateClauseBodyTx(...args);
    },
  };
});

const { db } = await import("../db/connection.js");
const { documents, docComments, docSections, standardClauses } = await import("../db/schema.js");
const { createStandard, proposeStandardChange } = await import("./standards.js");
const { addClausesToSection } = await import("./clauses.js");
const { acceptStandardChange } = await import("./standard-accept.js");
const { makeTestMemex } = await import("./test-helpers.js");
const { tagAc } = await import("@memex-ai-ac/vitest");

const AC_10 = "mindset-prod/memex-building-itself/specs/spec-530/acs/ac-10";

const createdDocIds: string[] = [];
let memexId: string;

beforeAll(async () => {
  memexId = await makeTestMemex("s530atom");
});

afterAll(async () => {
  failOnBodyWrite = null;
  vi.restoreAllMocks();
  for (const id of createdDocIds) {
    await db.delete(documents).where(eq(documents.id, id)).catch(() => {});
  }
});

async function liveBodies(sectionId: string): Promise<string[]> {
  const rows = await db
    .select()
    .from(standardClauses)
    .where(and(eq(standardClauses.sectionId, sectionId), ne(standardClauses.status, "deleted")))
    .orderBy(asc(standardClauses.position), asc(standardClauses.seq));
  return rows.map((r) => r.body);
}

describe("spec-530 ac-10: a failure mid-set leaves the Standard exactly as it was", () => {
  it("forced failure on operation 2 of 3 applies NOTHING and leaves the proposal open", async () => {
    tagAc(AC_10);
    const std = await createStandard(memexId, {
      title: "Atomicity Target Standard",
      sections: [{ sectionType: "rule", content: "" }],
    });
    createdDocIds.push(std.id);
    const sectionId = std.sections[0].id;
    const clauses = await addClausesToSection(memexId, sectionId, [
      { body: "one", facets: [] },
      { body: "two", facets: [] },
      { body: "three", facets: [] },
    ]);

    const proposal = await proposeStandardChange(memexId, [
      { op: "edit", clauseId: clauses[0].id, after: "one-changed" },
      { op: "edit", clauseId: clauses[1].id, after: "two-changed" },
      { op: "edit", clauseId: clauses[2].id, after: "three-changed" },
    ]);

    const contentBefore = (
      await db.query.docSections.findFirst({ where: eq(docSections.id, sectionId) })
    )!.content;

    bodyWriteCalls = 0;
    failOnBodyWrite = 2; // operation 2 of 3

    await expect(acceptStandardChange(memexId, proposal.comment.id)).rejects.toThrow(
      /injected mid-transaction fault/,
    );
    failOnBodyWrite = null;

    // Operation 1 DID execute before the fault — and it is gone. That is the whole
    // claim: clause 1 is byte-identical to its pre-call state, not "one-changed".
    expect(await liveBodies(sectionId)).toEqual(["one", "two", "three"]);
    expect(
      (await db.query.docSections.findFirst({ where: eq(docSections.id, sectionId) }))!.content,
    ).toBe(contentBefore);

    // And the proposal is still open, so the Standard and its Inbox agree about what
    // has happened: nothing.
    const comment = await db.query.docComments.findFirst({
      where: eq(docComments.id, proposal.comment.id),
    });
    expect(comment!.resolvedAt).toBeNull();
    expect(comment!.resolution).toBeNull();
  });

  it("the same proposal applies cleanly once the fault is gone — the rollback lost nothing", async () => {
    tagAc(AC_10);
    const std = await createStandard(memexId, {
      title: "Atomicity Retry Standard",
      sections: [{ sectionType: "rule", content: "" }],
    });
    createdDocIds.push(std.id);
    const sectionId = std.sections[0].id;
    const clauses = await addClausesToSection(memexId, sectionId, [
      { body: "alpha", facets: [] },
      { body: "beta", facets: [] },
    ]);
    const proposal = await proposeStandardChange(memexId, [
      { op: "edit", clauseId: clauses[0].id, after: "alpha-changed" },
      { op: "edit", clauseId: clauses[1].id, after: "beta-changed" },
    ]);

    bodyWriteCalls = 0;
    failOnBodyWrite = 2;
    await expect(acceptStandardChange(memexId, proposal.comment.id)).rejects.toThrow();
    failOnBodyWrite = null;

    // A refused accept is not a spent one. The proposal's stored "before" still matches
    // the live clauses precisely BECAUSE the rollback was total — so dec-3's staleness
    // guard passes and the retry succeeds.
    await acceptStandardChange(memexId, proposal.comment.id);
    expect(await liveBodies(sectionId)).toEqual(["alpha-changed", "beta-changed"]);
  });
});
