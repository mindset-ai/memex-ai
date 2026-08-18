// spec-530 t-4 (dec-4) — `accept_standard_change`, the transactional apply verb.
//
// Before this, accepting a proposal was impossible: proposals were section-grained and
// `update_section` hard-rejects on a Standard, so the only instruction the drift agent
// had was a call that always threw. This suite is the proof the loop closes.
//
// The atomicity ROLLBACK case lives in its own file
// (standard-accept-atomicity.spec-530.integration.test.ts) because it mocks the clause
// write module, and a module mock leaks across every test in its file [per std-37].

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, asc, eq, ne } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, docComments, docSections, standardClauses, users } from "../db/schema.js";
import type { StandardClause } from "../db/schema.js";
import { bus, type ChangeEvent } from "./bus.js";
import { createStandard, proposeStandardChange } from "./standards.js";
import { addClausesToSection, createClause } from "./clauses.js";
import { acceptStandardChange } from "./standard-accept.js";
import { makeTestMemex } from "./test-helpers.js";
import type { RequestCtx } from "./mutate.js";
import { toolSpecs } from "../agent/tool-specs.js";
import { tagAc } from "@memex-ai-ac/vitest";

const AC = "mindset-prod/memex-building-itself/specs/spec-530/acs";

const createdDocIds: string[] = [];
const createdUserIds: string[] = [];
let memexId: string;
let accepter: { id: string; name: string };

// std-37: per-worker-unique identifiers so parallel workers never collide.
function uniqueEmail(who: string): string {
  return `spec530-t4-${who}-${process.env.VITEST_WORKER_ID ?? "0"}-${process.hrtime.bigint()}@example.com`;
}

beforeAll(async () => {
  memexId = await makeTestMemex("s530acc");
  const [row] = await db
    .insert(users)
    .values({ email: uniqueEmail("accepter"), name: "Rule Accepter" } as typeof users.$inferInsert)
    .returning();
  createdUserIds.push(row.id);
  accepter = { id: row.id, name: "Rule Accepter" };
});

afterAll(async () => {
  for (const id of createdDocIds) {
    await db.delete(documents).where(eq(documents.id, id)).catch(() => {});
  }
  for (const id of createdUserIds) {
    await db.delete(users).where(eq(users.id, id)).catch(() => {});
  }
});

/** ctx as an authenticated in-app agent accept. */
function accepterCtx(): RequestCtx {
  return { actorUserId: accepter.id, channel: "in_app_agent" };
}

/** A Standard with one section carrying `bodies` as ordered clauses. */
async function seededStandard(bodies: string[]): Promise<{
  docId: string;
  sectionId: string;
  clauses: StandardClause[];
}> {
  const std = await createStandard(memexId, {
    title: "Accept Target Standard",
    sections: [{ sectionType: "rule", content: "" }],
  });
  createdDocIds.push(std.id);
  const sectionId = std.sections[0].id;
  const clauses = await addClausesToSection(
    memexId,
    sectionId,
    bodies.map((body) => ({ body, facets: [] })),
  );
  return { docId: std.id, sectionId, clauses: [...clauses] };
}

async function liveRows(sectionId: string): Promise<StandardClause[]> {
  return db
    .select()
    .from(standardClauses)
    .where(and(eq(standardClauses.sectionId, sectionId), ne(standardClauses.status, "deleted")))
    .orderBy(asc(standardClauses.position), asc(standardClauses.seq));
}

async function commentRow(commentId: string) {
  return db.query.docComments.findFirst({ where: eq(docComments.id, commentId) });
}

async function sectionRow(sectionId: string) {
  const row = await db.query.docSections.findFirst({ where: eq(docSections.id, sectionId) });
  return row!;
}

async function captureEvents(body: () => Promise<void>): Promise<ChangeEvent[]> {
  const events: ChangeEvent[] = [];
  const unsub = bus.subscribe({}, (e) => events.push(e));
  try {
    await body();
  } finally {
    unsub();
  }
  return events;
}

describe("spec-530 t-4: a proposal is applied and resolved in one operation", () => {
  it("applies a mixed add/edit/delete set and resolves the comment (ac-10)", async () => {
    tagAc(`${AC}/ac-10`);
    const { sectionId, clauses } = await seededStandard(["keep me", "edit me", "delete me"]);

    const proposal = await proposeStandardChange(memexId, [
      { op: "edit", clauseId: clauses[1].id, after: "edited by the proposal" },
      { op: "delete", clauseId: clauses[2].id },
      { op: "add", anchorClauseId: clauses[0].id, placement: "after", body: "added by the proposal" },
    ]);

    const result = await acceptStandardChange(memexId, proposal.comment.id, accepterCtx());

    expect(result.applied).toBe(3);
    const rows = await liveRows(sectionId);
    expect(rows.map((r) => r.body)).toEqual([
      "keep me",
      "added by the proposal",
      "edited by the proposal",
    ]);
    // The comment is resolved in the SAME operation — there is no window where the
    // Standard is rewritten and the proposal still open, or the reverse.
    const comment = await commentRow(proposal.comment.id);
    expect(comment!.resolvedAt).not.toBeNull();
    expect(comment!.resolution).toBe("accepted");
    // And the derived rule text a reader sees was regenerated from the new row set.
    expect((await sectionRow(sectionId)).content).toBe(
      "keep me\n\nadded by the proposal\n\nedited by the proposal",
    );
  });

  it("applies exactly the text that was proposed — no argument can change it (ac-11)", async () => {
    tagAc(`${AC}/ac-11`);
    const { sectionId, clauses } = await seededStandard(["the original rule"]);
    const proposedText = "the corrected rule, verbatim — including `~~~` and ``` fences";

    const proposal = await proposeStandardChange(memexId, [
      { op: "edit", clauseId: clauses[0].id, after: proposedText },
    ]);
    await acceptStandardChange(memexId, proposal.comment.id, accepterCtx());

    // What landed is byte-identical to what a human reviewed. That is what makes "the
    // user approved THIS text" a fact rather than a hope about the agent's fidelity.
    expect((await liveRows(sectionId))[0].body).toBe(proposedText);
  });

  it("exposes no body or target parameter on the tool at all (ac-11)", async () => {
    tagAc(`${AC}/ac-11`);
    const spec = toolSpecs.find((s) => s.name === "accept_standard_change");
    expect(spec, "accept_standard_change is not registered").toBeDefined();

    // The whole surface is the proposal ref (+ the shared verbose flag). No `body`, no
    // `operations`, no `clause` — there is no argument through which a caller could
    // apply something other than what was proposed and reviewed.
    expect(Object.keys(spec!.schema).sort()).toEqual(["ref", "verbose"]);
  });

  it("emits so an open Inbox and the drift-count chip both clear themselves (ac-12)", async () => {
    tagAc(`${AC}/ac-12`);
    const { docId, clauses } = await seededStandard(["a rule that will change"]);
    const proposal = await proposeStandardChange(memexId, [
      { op: "edit", clauseId: clauses[0].id, after: "the changed rule" },
    ]);

    const events = await captureEvents(async () => {
      await acceptStandardChange(memexId, proposal.comment.id, accepterCtx());
    });

    const mine = events.filter((e) => e.memexId === memexId && e.docId === docId);
    // The aggregate the StandardList drift-count subscriber watches — mirrors the dual
    // emit proposeStandardChange already performs. Without it the chip keeps counting a
    // proposal that is no longer open.
    expect(mine.some((e) => e.entity === "standard_drift")).toBe(true);
    // The Inbox row itself.
    expect(mine.some((e) => e.entity === "comment" && e.action === "updated")).toBe(true);
    // And the rule text that changed.
    expect(mine.some((e) => e.entity === "clause" && e.action === "updated")).toBe(true);
    expect(mine.some((e) => e.entity === "section" && e.action === "updated")).toBe(true);
  });

  it("attributes the rule change to whoever accepted it, and how (ac-20)", async () => {
    tagAc(`${AC}/ac-20`);
    const { sectionId, clauses } = await seededStandard(["unattributed rule"]);
    const proposal = await proposeStandardChange(memexId, [
      { op: "edit", clauseId: clauses[0].id, after: "attributed rule" },
    ]);

    await acceptStandardChange(memexId, proposal.comment.id, accepterCtx());

    // "Who changed this rule, and from where" is precisely the question the activity
    // contract exists to answer [per std-32 cl-1, cl-3, cl-4], and an accept is the one
    // mutation where it matters most.
    const row = await sectionRow(sectionId);
    expect(row.content).toContain("attributed rule");
    expect(row.actorUserId).toBe(accepter.id);
    expect(row.actorName).toBe(accepter.name);
    expect(row.channel).toBe("in_app_agent");
  });
});

describe("spec-530 t-4: adding a clause is proposable, and lands where it was meant to", () => {
  it("adds a clause that did not exist, with a fresh cl-N, siblings unresequenced (ac-9)", async () => {
    tagAc(`${AC}/ac-9`);
    const { sectionId, clauses } = await seededStandard(["first rule", "second rule"]);
    const seqsBefore = clauses.map((c) => c.seq);

    // "The rule is missing a case" — expressible as a proposal at all only because
    // dec-1 made a proposal a set of OPERATIONS rather than a single clause edit.
    const proposal = await proposeStandardChange(memexId, [
      { op: "add", anchorClauseId: clauses[0].id, placement: "after", body: "the missing case" },
    ]);
    await acceptStandardChange(memexId, proposal.comment.id, accepterCtx());

    const rows = await liveRows(sectionId);
    expect(rows.map((r) => r.body)).toEqual(["first rule", "the missing case", "second rule"]);

    // A FRESH handle, allocate-once — and every pre-existing cl-N is untouched
    // [per spec-150 dec-2: seq is identity, position is order].
    const added = rows[1];
    expect(seqsBefore).not.toContain(added.seq);
    expect(added.seq).toBeGreaterThan(Math.max(...seqsBefore));
    const survivingSeqs = rows.filter((r) => r.id !== added.id).map((r) => r.seq);
    expect(survivingSeqs).toEqual(seqsBefore);
  });

  it("lands next to its ANCHOR even after a clause was inserted ahead of it (ac-19)", async () => {
    tagAc(`${AC}/ac-19`);
    const { sectionId, clauses } = await seededStandard(["alpha", "beta", "gamma"]);

    // Authored when `beta` sat at ordinal 2.
    const proposal = await proposeStandardChange(memexId, [
      { op: "add", anchorClauseId: clauses[1].id, placement: "after", body: "after-beta" },
    ]);

    // Between authoring and accepting, someone inserts a clause AHEAD of the anchor.
    // Every ordinal after it shifts — so an ordinal captured at authoring time now
    // points at the wrong place, and nothing would detect that. This is why the
    // proposal stores an anchor cl-N and the accept resolves it at apply time.
    await createClause(memexId, sectionId, "wedged-in", 1);

    await acceptStandardChange(memexId, proposal.comment.id, accepterCtx());

    const rows = await liveRows(sectionId);
    expect(rows.map((r) => r.body)).toEqual([
      "wedged-in",
      "alpha",
      "beta",
      "after-beta",
      "gamma",
    ]);
    // Had the stored ordinal been used, "after-beta" would have landed at position 3 —
    // between alpha and beta — silently attaching the new rule to the wrong clause.
  });

  it("resolves each anchor against the state the EARLIER operations left behind (ac-19)", async () => {
    tagAc(`${AC}/ac-19`);
    const { sectionId, clauses } = await seededStandard(["A", "B", "C"]);

    // Two adds in one proposal. The first inserts ahead of the second's anchor, so by
    // the time operation 2 runs, B has moved — WITHIN this same transaction, after the
    // pre-flight read. Resolving anchors once up front is not enough; each has to be
    // read against the rows as they now stand.
    const proposal = await proposeStandardChange(memexId, [
      { op: "add", anchorClauseId: clauses[0].id, placement: "after", body: "X" },
      { op: "add", anchorClauseId: clauses[1].id, placement: "after", body: "Y" },
    ]);
    await acceptStandardChange(memexId, proposal.comment.id, accepterCtx());

    expect((await liveRows(sectionId)).map((r) => r.body)).toEqual(["A", "X", "B", "Y", "C"]);
    // With a stale ordinal for B, Y lands directly after X — ["A","X","Y","B","C"] —
    // attaching the new rule to the wrong clause with nothing to detect it.
  });

  it("refuses when the anchor was deleted after authoring, rather than appending (ac-16)", async () => {
    tagAc(`${AC}/ac-16`);
    const { sectionId, clauses } = await seededStandard(["anchor rule", "other rule"]);
    const proposal = await proposeStandardChange(memexId, [
      { op: "add", anchorClauseId: clauses[0].id, placement: "after", body: "orphaned addition" },
    ]);

    const anchorHandle = `cl-${clauses[0].seq}`;
    const { deleteClause } = await import("./clauses.js");
    await deleteClause(memexId, clauses[0].id);

    // A clause proposed relative to a clause that no longer exists has no defined
    // position. Guessing (appending to the end) would put a rule somewhere nobody chose.
    await expect(acceptStandardChange(memexId, proposal.comment.id)).rejects.toThrow(
      new RegExp(anchorHandle),
    );

    // And nothing was written.
    expect((await liveRows(sectionId)).map((r) => r.body)).toEqual(["other rule"]);
    expect((await commentRow(proposal.comment.id))!.resolvedAt).toBeNull();
  });
});

describe("spec-530 t-4: the verb refuses what it cannot honestly apply", () => {
  it("refuses a proposal that is already resolved", async () => {
    tagAc(`${AC}/ac-10`);
    const { clauses } = await seededStandard(["a rule"]);
    const proposal = await proposeStandardChange(memexId, [
      { op: "edit", clauseId: clauses[0].id, after: "a corrected rule" },
    ]);
    await acceptStandardChange(memexId, proposal.comment.id, accepterCtx());

    // Re-accepting must not apply the same edit twice or silently succeed.
    await expect(acceptStandardChange(memexId, proposal.comment.id)).rejects.toThrow(
      /already resolved/i,
    );
  });

  it("refuses a legacy whole-section proposal with the reason, never half-applying it (ac-18)", async () => {
    tagAc(`${AC}/ac-18`);
    const { sectionId, clauses } = await seededStandard(["a rule with a legacy proposal"]);
    const proposal = await proposeStandardChange(memexId, [
      { op: "edit", clauseId: clauses[0].id, after: "irrelevant" },
    ]);

    // Rewrite the stored body into the PRE-cutover single-fence shape — what a row
    // written before spec-530 actually looks like (a straggler from a long-running
    // branch, a restored backup, an environment converted at a different time).
    await db
      .update(docComments)
      .set({
        content: [
          "**Proposed change to section [rule]**",
          "",
          "legacy rationale",
          "",
          "~~~proposed-content",
          "A whole replacement section body.",
          "~~~",
        ].join("\n"),
      })
      .where(eq(docComments.id, proposal.comment.id));

    await expect(acceptStandardChange(memexId, proposal.comment.id)).rejects.toThrow(
      /clause grain/i,
    );
    // The rule is untouched and the proposal stays open — one unapplicable row, not a
    // corrupted Standard.
    expect((await liveRows(sectionId))[0].body).toBe("a rule with a legacy proposal");
    expect((await commentRow(proposal.comment.id))!.resolvedAt).toBeNull();
  });

  it("refuses a comment that is not a proposal at all", async () => {
    tagAc(`${AC}/ac-10`);
    const { docId, sectionId } = await seededStandard(["a rule"]);
    const { flagDrift } = await import("./standards.js");
    const drift = await flagDrift(memexId, sectionId, "the code diverged from this rule");
    expect(drift.docId ?? docId).toBeTruthy();

    // A drift observation carries no operations. Applying one is meaningless, and the
    // refusal says which kind it actually is.
    await expect(acceptStandardChange(memexId, drift.id)).rejects.toThrow(/not a proposal/i);
  });

  it("does not find a proposal that belongs to another memex (std-7)", async () => {
    tagAc(`${AC}/ac-10`);
    const { clauses } = await seededStandard(["a tenant-scoped rule"]);
    const proposal = await proposeStandardChange(memexId, [
      { op: "edit", clauseId: clauses[0].id, after: "changed" },
    ]);
    const otherMemexId = await makeTestMemex("s530acc-other");

    // 404-shaped, not 403 — an unauthorized resource is indistinguishable from one that
    // does not exist [per std-7].
    await expect(acceptStandardChange(otherMemexId, proposal.comment.id)).rejects.toThrow(
      /not found/i,
    );
  });
});
