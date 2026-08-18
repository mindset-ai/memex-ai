// spec-530 t-7 — the Drift Inbox read model carries a proposal's OPERATIONS, resolved
// against the live clauses.
//
// Until now `proposedContent` was the only thing on the wire, and for a clause-grained
// proposal it is the raw comment body — which is why `DriftInbox.tsx` rendered nothing
// and its header comment claimed the diff was "reachable via Discuss with Agent or the
// standard page", a claim verified false on both counts.
//
// The row needs three things per operation the client cannot derive: which clause
// (`cl-N`), what the proposal wants it to say, and what it says RIGHT NOW. The last one
// is a database read, so it belongs here rather than in the client.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, docComments } from "../db/schema.js";
import type { StandardClause } from "../db/schema.js";
import { createStandard, proposeStandardChange } from "./standards.js";
import { addClausesToSection, updateClause } from "./clauses.js";
import { listDriftInbox } from "./drift-inbox.js";
import { makeTestMemex } from "./test-helpers.js";
import { tagAc } from "@memex-ai-ac/vitest";

const AC_18 = "mindset-prod/memex-building-itself/specs/spec-530/acs/ac-18";

const createdDocIds: string[] = [];
let memexId: string;

beforeAll(async () => {
  memexId = await makeTestMemex("s530inbox");
});

afterAll(async () => {
  for (const id of createdDocIds) {
    await db.delete(documents).where(eq(documents.id, id)).catch(() => {});
  }
});

async function seededStandard(
  title: string,
  bodies: string[],
): Promise<{ docId: string; sectionId: string; clauses: StandardClause[] }> {
  const std = await createStandard(memexId, {
    title,
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

async function rowFor(commentId: string) {
  const page = await listDriftInbox(memexId, { limit: 200 });
  return page.items.find((i) => i.commentId === commentId);
}

describe("spec-530 t-7: the Inbox read model carries the proposal's operations", () => {
  it("returns each operation with its cl-N, the proposed text, and the LIVE clause body", async () => {
    const { clauses } = await seededStandard("Inbox Ops Standard", [
      "keep me",
      "edit me",
      "delete me",
    ]);
    const proposal = await proposeStandardChange(memexId, [
      { op: "edit", clauseId: clauses[1].id, after: "edited text" },
      { op: "delete", clauseId: clauses[2].id },
      { op: "add", anchorClauseId: clauses[0].id, placement: "after", body: "added text" },
    ]);

    const row = await rowFor(proposal.comment.id);
    expect(row?.proposal?.kind).toBe("clause-ops");
    const ops = row!.proposal!.kind === "clause-ops" ? row!.proposal!.operations : [];

    // Order is the proposal's own — a reviewer reads the operations as authored.
    expect(ops.map((o) => o.op)).toEqual(["edit", "delete", "add"]);
    expect(ops.map((o) => o.clause)).toEqual([
      `cl-${clauses[1].seq}`,
      `cl-${clauses[2].seq}`,
      `cl-${clauses[0].seq}`, // the ADD names its anchor
    ]);

    expect(ops[0]).toMatchObject({ before: "edit me", after: "edited text", current: "edit me" });
    expect(ops[1]).toMatchObject({ before: "delete me", current: "delete me" });
    expect(ops[1].after).toBeUndefined(); // nothing replaces a deletion
    expect(ops[2]).toMatchObject({ placement: "after", after: "added text", current: "keep me" });
    expect(ops[2].before).toBeUndefined(); // an add has no "before"
  });

  it("carries `current` as the LIVE body, which can differ from the authored `before`", async () => {
    const { clauses } = await seededStandard("Inbox Drift Standard", ["the original rule"]);
    const proposal = await proposeStandardChange(memexId, [
      { op: "edit", clauseId: clauses[0].id, after: "the proposed rule" },
    ]);

    // Someone corrects the clause after the proposal was authored.
    await updateClause(memexId, clauses[0].id, "the rule as someone else corrected it");

    const row = await rowFor(proposal.comment.id);
    const ops = row!.proposal!.kind === "clause-ops" ? row!.proposal!.operations : [];
    // Both travel, because they answer different questions: after-vs-current is the diff
    // a reviewer judges; before-vs-current is whether the proposal still applies. The
    // read model states both and derives NO verdict — dec-3 put that judgement inside
    // the accept transaction and dec-4 gave it exactly one home.
    expect(ops[0].before).toBe("the original rule");
    expect(ops[0].current).toBe("the rule as someone else corrected it");
    expect(ops[0].after).toBe("the proposed rule");
  });

  it("reports `current: null` when the targeted clause no longer exists", async () => {
    const { clauses } = await seededStandard("Inbox Gone Standard", ["doomed", "other"]);
    const proposal = await proposeStandardChange(memexId, [
      { op: "edit", clauseId: clauses[0].id, after: "never applied" },
    ]);
    const { deleteClause } = await import("./clauses.js");
    await deleteClause(memexId, clauses[0].id);

    const row = await rowFor(proposal.comment.id);
    const ops = row!.proposal!.kind === "clause-ops" ? row!.proposal!.operations : [];
    expect(ops[0].current).toBeNull();
    // The row still renders — a vanished target is one unusable operation, not a crash.
    expect(row?.proposal?.kind).toBe("clause-ops");
  });

  it("resolves cl-N per STANDARD, so two Standards' identical handles do not cross", async () => {
    // `seq` is allocated MAX+1 per doc, so cl-1 exists on every Standard. Matching on
    // seq alone would show one Standard's rule text under another's proposal.
    const a = await seededStandard("Inbox Collide A", ["A's first clause"]);
    const b = await seededStandard("Inbox Collide B", ["B's first clause"]);
    expect(a.clauses[0].seq).toBe(b.clauses[0].seq);

    const pa = await proposeStandardChange(memexId, [
      { op: "edit", clauseId: a.clauses[0].id, after: "A changed" },
    ]);
    const pb = await proposeStandardChange(memexId, [
      { op: "edit", clauseId: b.clauses[0].id, after: "B changed" },
    ]);

    const rowA = await rowFor(pa.comment.id);
    const rowB = await rowFor(pb.comment.id);
    const opsA = rowA!.proposal!.kind === "clause-ops" ? rowA!.proposal!.operations : [];
    const opsB = rowB!.proposal!.kind === "clause-ops" ? rowB!.proposal!.operations : [];
    expect(opsA[0].current).toBe("A's first clause");
    expect(opsB[0].current).toBe("B's first clause");
  });

  it("reports a pre-cutover body as legacy rather than throwing (ac-18)", async () => {
    tagAc(AC_18);
    const { clauses } = await seededStandard("Inbox Legacy Standard", ["a rule"]);
    const proposal = await proposeStandardChange(memexId, [
      { op: "edit", clauseId: clauses[0].id, after: "irrelevant" },
    ]);
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

    const row = await rowFor(proposal.comment.id);
    expect(row?.proposal).toEqual({
      kind: "legacy",
      proposed: "A whole replacement section body.",
    });
  });

  it("reports an unparseable body as unreadable, and the rest of the page still renders (ac-18)", async () => {
    tagAc(AC_18);
    const { clauses } = await seededStandard("Inbox Corrupt Standard", ["a rule"]);
    const corrupt = await proposeStandardChange(memexId, [
      { op: "edit", clauseId: clauses[0].id, after: "irrelevant" },
    ]);
    await db
      .update(docComments)
      .set({ content: "someone wrote a plan_revision by hand with no payload at all" })
      .where(eq(docComments.id, corrupt.comment.id));

    // A second, healthy proposal on the same page.
    const healthy = await seededStandard("Inbox Healthy Standard", ["another rule"]);
    const good = await proposeStandardChange(memexId, [
      { op: "edit", clauseId: healthy.clauses[0].id, after: "a good change" },
    ]);

    const page = await listDriftInbox(memexId, { limit: 200 });
    expect(page.items.find((i) => i.commentId === corrupt.comment.id)?.proposal).toEqual({
      kind: "unreadable",
    });
    // The blast radius of one bad body is ONE row, never the page.
    expect(page.items.find((i) => i.commentId === good.comment.id)?.proposal?.kind).toBe(
      "clause-ops",
    );
  });

  it("leaves a drift observation with no proposal at all", async () => {
    const { sectionId } = await seededStandard("Inbox Observation Standard", ["a rule"]);
    const { flagDrift } = await import("./standards.js");
    const drift = await flagDrift(memexId, sectionId, "the code diverged");

    const row = await rowFor(drift.id);
    expect(row?.proposal).toBeNull();
    expect(row?.proposedContent).toBeNull();
  });
});
