// spec-530 t-9 (ac-18) — a proposal the clause path cannot apply DEGRADES; it never
// half-applies and never crashes the caller.
//
// t-9's criteria were written against a two-shape world: clause-grained, or "legacy"
// (a pre-cutover whole-section replacement inside a `~~~proposed-content` fence). t-11's
// sweep of all 49 Standards found a THIRD shape and it is not rare — of the six open
// proposals in the real corpus, three were free-form prose with no fence at all, written
// before `propose_standard_change` was the only way to author one. Those parse to
// neither shape: `parseProposedChangeBody` returns null.
//
// The accept verb already refuses both, but only the `legacy` branch had a test. This
// file covers the branch the real corpus actually hits most, and pins the property that
// matters for both: the Standard is untouched and the proposal stays open, so a body
// nobody can apply costs one unusable row rather than a damaged rule or a stuck loop.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, asc, eq, ne } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, docComments, standardClauses } from "../db/schema.js";
import type { StandardClause } from "../db/schema.js";
import { createStandard, proposeStandardChange } from "./standards.js";
import { addClausesToSection } from "./clauses.js";
import { acceptStandardChange } from "./standard-accept.js";
import { listDriftInbox } from "./drift-inbox.js";
import { makeTestMemex } from "./test-helpers.js";
import { tagAc } from "@memex-ai-ac/vitest";

const AC_18 = "mindset-prod/memex-building-itself/specs/spec-530/acs/ac-18";

const createdDocIds: string[] = [];
let memexId: string;

beforeAll(async () => {
  memexId = await makeTestMemex("s530degr");
});

afterAll(async () => {
  for (const id of createdDocIds) {
    await db.delete(documents).where(eq(documents.id, id)).catch(() => {});
  }
});

async function seeded(bodies: string[]): Promise<{ sectionId: string; clauses: StandardClause[] }> {
  const std = await createStandard(memexId, {
    title: "Degrade Target Standard",
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

/** Overwrite a real proposal's stored body, standing in for a row written before the
 *  clause grain existed. Going through proposeStandardChange first keeps every other
 *  column (type, section anchor, source) exactly as the product produces it. */
async function withBody(clauseId: string, content: string): Promise<string> {
  const proposal = await proposeStandardChange(memexId, [
    { op: "edit", clauseId, after: "irrelevant" },
  ]);
  await db.update(docComments).set({ content }).where(eq(docComments.id, proposal.comment.id));
  return proposal.comment.id;
}

describe("spec-530 t-9: an unapplicable proposal degrades, it does not half-apply (ac-18)", () => {
  it("refuses a FREE-FORM proposal — the shape half the real corpus turned out to be", async () => {
    tagAc(AC_18);
    const { sectionId, clauses } = await seeded(["the rule as it stands"]);
    // Modelled on std-19 c-1, a real proposal found by t-11's sweep: prose, no fence,
    // authored when propose_standard_change could not take the target the author had.
    const commentId = await withBody(
      clauses[0].id,
      [
        "Proposed amendment (spec-164 dec-1 / ac-14) — add a clause to the Rule:",
        "",
        "(e) Phase values and phase display names are two sanctioned layers.",
        "",
        "(Filed as a plan_revision comment directly: propose_standard_change requires a",
        "section UUID that the MCP surface doesn't expose.)",
      ].join("\n"),
    );

    await expect(acceptStandardChange(memexId, commentId)).rejects.toThrow(
      /no readable operations/i,
    );

    // The rule is untouched and the proposal is still open — the two properties that
    // make an unapplicable body cost one row rather than a damaged Standard.
    expect(await liveBodies(sectionId)).toEqual(["the rule as it stands"]);
    const row = await db.query.docComments.findFirst({ where: eq(docComments.id, commentId) });
    expect(row!.resolvedAt).toBeNull();
  });

  it("refuses a body whose fenced payload is corrupt, rather than applying part of it", async () => {
    tagAc(AC_18);
    const { sectionId, clauses } = await seeded(["keep me exactly"]);
    // A clause-grained fence whose JSON is truncated — a restored backup, a partial
    // write. The parser must not surface a half-decoded operation set.
    const commentId = await withBody(
      clauses[0].id,
      [
        "**Proposed change to section [rule]**",
        "",
        "rationale",
        "",
        "~~~proposed-clauses",
        '{"v":1,"operations":[{"op":"edit","clause":"cl-1","before":"keep me exact',
        "~~~",
      ].join("\n"),
    );

    await expect(acceptStandardChange(memexId, commentId)).rejects.toThrow(
      /no readable operations/i,
    );
    expect(await liveBodies(sectionId)).toEqual(["keep me exactly"]);
  });

  it("keeps the Inbox readable when a page mixes all three shapes", async () => {
    tagAc(AC_18);
    // The real corpus t-11 found: clause-grained, legacy-fenced, and free-form, side by
    // side. One unreadable row must not cost the reader the other two.
    const good = await seeded(["a rule that will change"]);
    const goodProposal = await proposeStandardChange(memexId, [
      { op: "edit", clauseId: good.clauses[0].id, after: "the changed rule" },
    ]);

    const legacy = await seeded(["a rule with a legacy proposal"]);
    const legacyId = await withBody(
      legacy.clauses[0].id,
      [
        "**Proposed change to section [rule]**",
        "",
        "legacy rationale",
        "",
        "~~~proposed-content",
        "A whole replacement section body.",
        "~~~",
      ].join("\n"),
    );

    const free = await seeded(["a rule with a free-form proposal"]);
    const freeId = await withBody(free.clauses[0].id, "Someone's prose, no fence at all.");

    const page = await listDriftInbox(memexId, { limit: 200 });
    const byId = new Map(page.items.map((i) => [i.commentId, i]));
    expect(byId.get(goodProposal.comment.id)?.proposal?.kind).toBe("clause-ops");
    expect(byId.get(legacyId)?.proposal?.kind).toBe("legacy");
    expect(byId.get(freeId)?.proposal?.kind).toBe("unreadable");

    // Every row still carries the context the reader triages on — the blast radius of an
    // unapplicable body is its own row's diff, nothing else.
    for (const id of [goodProposal.comment.id, legacyId, freeId]) {
      const item = byId.get(id)!;
      expect(item.doc.handle).toMatch(/^std-/);
      expect(item.commentHandle).toMatch(/^c-\d+$/);
    }
  });
});
