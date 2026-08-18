// spec-530 t-5 (dec-3, ac-14/ac-15) — the staleness guard inside the accept.
//
// A proposal is a stale read BY NATURE: authored at T0, accepted at T1, possibly days
// later and possibly after another agent edited the very clause it targets. Applying it
// blind at T1 discards that intervening edit silently — and "a Standard losing a
// correction without anyone noticing" is the failure this whole Spec exists to prevent.
// Fixing the grain while leaving that hole would have traded one silent-loss bug for
// another.
//
// The guard lives in the PROPOSAL (dec-3), not on `edit_clause`: the staleness is the
// proposal's, so the evidence belongs next to the text a reviewer is already reading,
// and no other caller's contract moves. dec-4 then gives the comparison exactly one
// home — inside the accept transaction, with no path that skips it.
//
// Separate file from the happy path because this is the SAFETY property, and safety
// properties that ride along with happy paths are the ones that ship untested.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, asc, eq, ne } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, docComments, standardClauses } from "../db/schema.js";
import type { StandardClause } from "../db/schema.js";
import { createStandard, proposeStandardChange } from "./standards.js";
import { addClausesToSection, updateClause } from "./clauses.js";
import { acceptStandardChange } from "./standard-accept.js";
import { makeTestMemex } from "./test-helpers.js";
import { tagAc } from "@memex-ai-ac/vitest";

const AC = "mindset-prod/memex-building-itself/specs/spec-530/acs";

const createdDocIds: string[] = [];
let memexId: string;

beforeAll(async () => {
  memexId = await makeTestMemex("s530stale");
});

afterAll(async () => {
  for (const id of createdDocIds) {
    await db.delete(documents).where(eq(documents.id, id)).catch(() => {});
  }
});

async function seededStandard(bodies: string[]): Promise<{
  sectionId: string;
  clauses: StandardClause[];
}> {
  const std = await createStandard(memexId, {
    title: "Staleness Target Standard",
    sections: [{ sectionType: "rule", content: "" }],
  });
  createdDocIds.push(std.id);
  const sectionId = std.sections[0].id;
  const clauses = await addClausesToSection(
    memexId,
    sectionId,
    bodies.map((body) => ({ body, facets: [] })),
  );
  return { sectionId, clauses: [...clauses] };
}

async function liveBodies(sectionId: string): Promise<string[]> {
  const rows = await db
    .select()
    .from(standardClauses)
    .where(and(eq(standardClauses.sectionId, sectionId), ne(standardClauses.status, "deleted")))
    .orderBy(asc(standardClauses.position), asc(standardClauses.seq));
  return rows.map((r) => r.body);
}

async function isOpen(commentId: string): Promise<boolean> {
  const row = await db.query.docComments.findFirst({ where: eq(docComments.id, commentId) });
  return row!.resolvedAt === null;
}

describe("spec-530 ac-14: accepting a stale proposal cannot discard someone else's edit", () => {
  it("refuses, and the clause still holds the intervening edit byte-identical", async () => {
    tagAc(`${AC}/ac-14`);
    tagAc(`${AC}/ac-3`); // scope: the outcome this mechanism delivers
    const { sectionId, clauses } = await seededStandard(["cache all writes"]);

    // T0 — the proposal is authored against what the rule says today.
    const proposal = await proposeStandardChange(memexId, [
      { op: "edit", clauseId: clauses[0].id, after: "cache all writes, including PUT" },
    ]);

    // Between T0 and T1 someone else corrects the same clause. This is the edit that
    // must survive.
    const intervening = "cache all writes except mutating endpoints";
    await updateClause(memexId, clauses[0].id, intervening);

    // T1 — the accept must fail loudly rather than overwrite.
    await expect(acceptStandardChange(memexId, proposal.comment.id)).rejects.toThrow(
      /changed after this proposal was written/i,
    );

    expect(await liveBodies(sectionId)).toEqual([intervening]);
    expect(await isOpen(proposal.comment.id)).toBe(true);
  });

  it("refuses on a WHITESPACE-only divergence too — exactness is the point", async () => {
    tagAc(`${AC}/ac-14`);
    const { sectionId, clauses } = await seededStandard(["never log secrets"]);
    const proposal = await proposeStandardChange(memexId, [
      { op: "edit", clauseId: clauses[0].id, after: "never log secrets or tokens" },
    ]);

    // A trailing space is a real difference. A "close enough" comparison would reopen
    // the silent-overwrite class this guard exists to close, and the cost of a false
    // refusal is one re-proposal — deliberately the cheaper failure (dec-3).
    const nudged = "never log secrets ";
    await updateClause(memexId, clauses[0].id, nudged);

    await expect(acceptStandardChange(memexId, proposal.comment.id)).rejects.toThrow();
    expect(await liveBodies(sectionId)).toEqual([nudged]);
  });

  it("applies normally when nothing moved — the guard is not a general obstacle", async () => {
    tagAc(`${AC}/ac-14`);
    const { sectionId, clauses } = await seededStandard(["retry idempotent calls"]);
    const proposal = await proposeStandardChange(memexId, [
      { op: "edit", clauseId: clauses[0].id, after: "retry idempotent calls up to 3 times" },
    ]);

    await acceptStandardChange(memexId, proposal.comment.id);

    expect(await liveBodies(sectionId)).toEqual(["retry idempotent calls up to 3 times"]);
    expect(await isOpen(proposal.comment.id)).toBe(false);
  });

  it("guards DELETE operations, not only edits", async () => {
    tagAc(`${AC}/ac-14`);
    const { sectionId, clauses } = await seededStandard(["obsolete rule", "keeper"]);
    const proposal = await proposeStandardChange(memexId, [
      { op: "delete", clauseId: clauses[0].id },
    ]);

    // The clause someone thought was obsolete has since been rewritten into something
    // current. Deleting it now would discard that work with no trace.
    await updateClause(memexId, clauses[0].id, "rule, now rewritten and current");

    await expect(acceptStandardChange(memexId, proposal.comment.id)).rejects.toThrow(
      /changed after this proposal was written/i,
    );
    expect(await liveBodies(sectionId)).toEqual(["rule, now rewritten and current", "keeper"]);
  });
});

describe("spec-530 ac-15: one stale operation refuses the ENTIRE set, actionably", () => {
  it("applies nothing when only operation 2 of 3 has drifted", async () => {
    tagAc(`${AC}/ac-15`);
    const { sectionId, clauses } = await seededStandard(["first", "second", "third"]);
    const proposal = await proposeStandardChange(memexId, [
      { op: "edit", clauseId: clauses[0].id, after: "first-changed" },
      { op: "edit", clauseId: clauses[1].id, after: "second-changed" },
      { op: "edit", clauseId: clauses[2].id, after: "third-changed" },
    ]);

    // Only the middle target moves.
    const drifted = "second, corrected by someone else";
    await updateClause(memexId, clauses[1].id, drifted);

    await expect(acceptStandardChange(memexId, proposal.comment.id)).rejects.toThrow();

    // A set is ONE reviewed intent. Applying the two clean operations would leave the
    // Standard saying something no one proposed — worse than the failure it replaces,
    // because it looks like success.
    expect(await liveBodies(sectionId)).toEqual(["first", drifted, "third"]);
    expect(await isOpen(proposal.comment.id)).toBe(true);
  });

  it("names the drifted clause AND what it now says, so the next move is obvious", async () => {
    tagAc(`${AC}/ac-15`);
    const { clauses } = await seededStandard(["alpha", "beta"]);
    const proposal = await proposeStandardChange(memexId, [
      { op: "edit", clauseId: clauses[0].id, after: "alpha-changed" },
      { op: "edit", clauseId: clauses[1].id, after: "beta-changed" },
    ]);

    const nowReads = "beta, as rewritten by another agent";
    await updateClause(memexId, clauses[1].id, nowReads);

    // "Conflict" alone fails this criterion: a reviewer would have to go and look. The
    // refusal has to carry enough to act on — re-propose against the current rule —
    // without further investigation.
    const err = await acceptStandardChange(memexId, proposal.comment.id).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain(`cl-${clauses[1].seq}`);
    expect(message).toContain(nowReads);
  });
});
