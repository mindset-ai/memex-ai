// spec-566 t-2 — the supersession verb: propose, accept, and the verdict reset.
//
// The property the whole verb exists for is ac-7: PROPOSING changes NOTHING.
// Rewriting a criterion has to cost more than satisfying it (ac-3), and it costs
// nothing at all if the proposal itself already moved the statement or the badge.
//
// Every assertion here reads state BACK from the database rather than trusting the
// verb's return value — the AC's own wording: "asserting only that the call
// succeeded proves nothing." A verb that returned a correct-looking object while
// writing something else would pass the weaker test.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import {
  acs,
  acParentLinks,
  decisions,
  documents,
  memexes,
  namespaces,
  specLifecycleEvents,
  tasks,
  testEventLatest,
  testEvents,
} from "../db/schema.js";
import { createAc, listAcsForBriefWithVerification } from "./acs.js";
import { createDecision } from "./decisions.js";
import { createDocDraft, updateDocStatus } from "./documents.js";
import { createTask, updateTaskStatus } from "./tasks.js";
import { makeTestMemex, seedTestEvent } from "./test-helpers.js";
import { acceptAcSupersession, proposeAcSupersession } from "./ac-supersession.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-566";

const ORIGINAL =
  "The exporter writes one row per invoice, and the total line reconciles to the ledger.";

let memexId: string;
let namespaceSlug: string;
let memexSlug: string;
const createdDocIds: string[] = [];
const createdRefs: string[] = [];

/** A Spec with one verified criterion and one decision to supersede it under. */
async function seedVerifiedAc(statement: string = ORIGINAL): Promise<{
  briefId: string;
  acId: string;
  ref: string;
  decisionId: string;
}> {
  const doc = await createDocDraft(memexId, "supersession fixture", "purpose", "spec");
  createdDocIds.push(doc.id);

  const ac = await createAc({
    memexId,
    briefId: doc.id,
    kind: "implementation",
    statement,
  });
  const ref = `${namespaceSlug}/${memexSlug}/specs/${doc.handle}/acs/ac-${ac.seq}`;
  createdRefs.push(ref);

  // A GREEN verdict is the precondition of ac-7's real claim. Without it the
  // "verdict unchanged" assertion would compare `untested` to `untested` and hold
  // however the verb behaved.
  await seedTestEvent({
    subjectRef: ref,
    status: "pass",
    testIdentifier: "packages/server/src/exporter.test.ts::reconciles",
  });

  const decision = await createDecision(
    memexId,
    doc.id,
    "Invoices are exported per line item, not per invoice",
  );

  return { briefId: doc.id, acId: ac.id, ref, decisionId: decision.id };
}

async function readBack(briefId: string, acId: string) {
  const rows = await listAcsForBriefWithVerification(memexId, briefId);
  const found = rows.find((r) => r.ac.id === acId);
  if (!found) throw new Error(`AC ${acId} vanished from the snapshot read`);
  return found;
}

beforeAll(async () => {
  memexId = await makeTestMemex("sup566");
  const [row] = await db
    .select({ m: memexes.slug, n: namespaces.slug })
    .from(memexes)
    .innerJoin(namespaces, eq(namespaces.id, memexes.namespaceId))
    .where(eq(memexes.id, memexId))
    .limit(1);
  memexSlug = row!.m;
  namespaceSlug = row!.n;
});

afterAll(async () => {
  if (createdRefs.length) {
    await db
      .delete(testEventLatest)
      .where(inArray(testEventLatest.subjectRef, createdRefs))
      .catch(() => {});
    await db
      .delete(testEvents)
      .where(inArray(testEvents.subjectRef, createdRefs))
      .catch(() => {});
  }
  if (createdDocIds.length) {
    await db.delete(documents).where(inArray(documents.id, createdDocIds)).catch(() => {});
  }
  const [row] = await db
    .select({ namespaceId: memexes.namespaceId })
    .from(memexes)
    .where(eq(memexes.id, memexId))
    .limit(1);
  if (row) await db.delete(namespaces).where(eq(namespaces.id, row.namespaceId)).catch(() => {});
});

describe("spec-566 t-2 — proposing a supersession changes nothing", () => {
  it("leaves the statement byte-identical and the verdict untouched, and reports the pending proposal", async () => {
    tagAc(`${SPEC}/acs/ac-7`);

    const { briefId, acId, decisionId } = await seedVerifiedAc();

    // ── Precondition, asserted rather than assumed ──
    // If the criterion were not already `verified` with no pending proposal, every
    // assertion after the call would hold for the wrong reason.
    const before = await readBack(briefId, acId);
    expect(before.ac.statement).toBe(ORIGINAL);
    expect(before.verificationState).toBe("verified");
    expect(before.supersessionProposed).toBe(false);

    await proposeAcSupersession(
      {
        memexId,
        acId,
        decisionId,
        proposedStatement:
          "The exporter writes one row per invoice LINE ITEM, and the total reconciles to the ledger.",
        rationale: "dec-N moved billing to line-item granularity; the old wording is now false.",
      },
      { channel: "mcp" },
    );

    // ── The claim: READ IT BACK ──
    const after = await readBack(briefId, acId);

    // Byte-identical, not "close enough": a proposal that normalises whitespace or
    // re-wraps the statement has already rewritten the criterion.
    expect(after.ac.statement).toBe(ORIGINAL);
    expect(after.ac.statement).toBe(before.ac.statement);

    // The verdict is UNCHANGED — a green criterion stays green until a human
    // accepts. ac-4's reset belongs to the accept, not to the proposal.
    expect(after.verificationState).toBe("verified");
    expect(after.ac.status).toBe("active");

    // ...and the pending proposal is visible. Without this the verb would be
    // indistinguishable from doing nothing at all, which is the other way to pass
    // every assertion above.
    expect(after.supersessionProposed).toBe(true);
  });
});

describe("spec-566 t-2 — the server owns the \"before\" text", () => {
  it("refuses a proposal that supplies the criterion's current text", async () => {
    tagAc(`${SPEC}/acs/ac-8`);

    const { acId, decisionId } = await seedVerifiedAc();

    // The caller forging agreement with text it chose. If this were accepted, the
    // accept's staleness guard would be comparing the proposal against itself and
    // would never fire — the guard would exist and guard nothing.
    await expect(
      proposeAcSupersession(
        {
          memexId,
          acId,
          decisionId,
          proposedStatement: "something else",
          before: ORIGINAL,
        } as unknown as Parameters<typeof proposeAcSupersession>[0],
        {},
      ),
    ).rejects.toThrow(/current text/i);

    // Vacuity guard: the SAME call without the forbidden field must succeed —
    // otherwise the rejection above proves only that the fixture is broken.
    const ok = await proposeAcSupersession(
      { memexId, acId, decisionId, proposedStatement: "something else" },
      {},
    );
    expect(ok.comment.acId).toBe(acId);
  });

  it("refuses a proposal with no superseding decision [dec-6]", async () => {
    // ac-18's first clause — the service-level half of "a call carrying no
    // decision ref is refused"; its UUID-vs-canonical half lives in the
    // uuid-input-rejection gate, which ac-18 asks to be extended rather than
    // duplicated.
    tagAc(`${SPEC}/acs/ac-18`);

    const { acId } = await seedVerifiedAc();
    await expect(
      proposeAcSupersession({ memexId, acId, decisionId: "  ", proposedStatement: "x" }, {}),
    ).rejects.toThrow(/decision/i);
  });
});

describe("spec-566 t-2 — accepting supersedes without rewriting", () => {
  it("preserves the original verbatim, reaches the successor through the decision, and stores no successor pointer", async () => {
    tagAc(`${SPEC}/acs/ac-19`);

    const { briefId, acId, decisionId } = await seedVerifiedAc();
    const REPLACEMENT =
      "The exporter writes one row per invoice LINE ITEM, and the total reconciles to the ledger.";

    const proposed = await proposeAcSupersession(
      { memexId, acId, decisionId, proposedStatement: REPLACEMENT },
      { channel: "mcp" },
    );
    const accepted = await acceptAcSupersession(memexId, proposed.comment.id, {
      channel: "rest_ui",
    });

    // The original is preserved VERBATIM, not rewritten (ac-1's half).
    const supersededRow = await db.query.acs.findFirst({ where: eq(acs.id, acId) });
    expect(supersededRow!.statement).toBe(ORIGINAL);
    expect(supersededRow!.status).toBe("superseded");

    // The traversal: retired criterion → superseding decision → its children.
    const linksFromSuperseded = await db
      .select()
      .from(acParentLinks)
      .where(eq(acParentLinks.acId, acId));
    const viaDecision = linksFromSuperseded.find(
      (l) => l.parentKind === "decision" && l.parentId === decisionId,
    );
    expect(viaDecision, "the retired criterion must hang off the superseding decision").toBeTruthy();

    const childrenOfDecision = await db
      .select({ acId: acParentLinks.acId })
      .from(acParentLinks)
      .where(and(eq(acParentLinks.parentKind, "decision"), eq(acParentLinks.parentId, decisionId)));
    const successorIds = childrenOfDecision.map((c) => c.acId).filter((id) => id !== acId);
    expect(successorIds).toContain(accepted.successor!.id);
    expect(accepted.successor!.statement).toBe(REPLACEMENT);

    // The second half ac-19 insists on: NO successor field on the criterion. A
    // stored pointer could disagree with the traversal; the absence IS the claim.
    const columns = Object.keys(supersededRow as Record<string, unknown>);
    expect(columns.filter((c) => /successor|replacedby|supersededby/i.test(c))).toEqual([]);

    const snapshot = await listAcsForBriefWithVerification(memexId, briefId);
    expect(snapshot.find((r) => r.ac.id === acId)!.ac.status).toBe("superseded");
    expect(snapshot.find((r) => r.ac.id === accepted.successor!.id)!.ac.status).toBe("active");
  });

  it("resets the verdict WITHOUT destroying the evidence that earned it", async () => {
    // ── SCOPE ACs, tagged here because this case proves their whole sentence ──
    //
    // ac-1: "recorded as superseded — its original statement preserved verbatim,
    // its successor named — without rewriting it, deleting it, or leaving it
    // asserting something the code contradicts." All four clauses are below: the
    // statement read back byte-identical, the successor reached by traversing the
    // superseding decision, the row still present (retired, not deleted), and the
    // status flipped so it no longer asserts against the live set.
    //
    // ac-3: "a material rewrite is a distinct, ATTRIBUTED act — not the same free
    // call as fixing a typo." The distinct act is propose→accept; the attribution
    // is the journal row's actor/channel/reason at the end of this case. The "not
    // the same free call" half is ac-23/ac-24's guards, which is why ac-3 is NOT
    // tagged on those alone — a criterion refused an edit proves the cost went up,
    // not that the alternative path signs its name.
    tagAc(`${SPEC}/acs/ac-4`);
    tagAc(`${SPEC}/acs/ac-1`);
    tagAc(`${SPEC}/acs/ac-3`);

    const { briefId, acId, ref, decisionId } = await seedVerifiedAc();

    const before = await readBack(briefId, acId);
    expect(before.verificationState).toBe("verified");
    const evidenceBefore = await db
      .select()
      .from(testEventLatest)
      .where(eq(testEventLatest.subjectRef, ref));
    expect(evidenceBefore.length).toBeGreaterThan(0);

    const proposed = await proposeAcSupersession(
      { memexId, acId, decisionId, proposedStatement: "A materially different claim." },
      {},
    );
    const accepted = await acceptAcSupersession(memexId, proposed.comment.id, {
      // ac-3's "attributed" half needs a real actor to assert against.
      channel: "rest_ui",
      actorName: "LJ Accepter",
    });

    // The reset: the NEW statement is not green. It has to earn its own verdict.
    const after = await listAcsForBriefWithVerification(memexId, briefId);
    const successor = after.find((r) => r.ac.id === accepted.successor!.id)!;
    expect(successor.verificationState).toBe("untested");
    expect(successor.tests).toEqual([]);

    // ...and the evidence is STILL THERE. This half is what keeps ac-4 consistent
    // with dec-3 and ac-5: resetting the verdict by DELETING test_events would make
    // an accept destroy evidence — the very act this Spec says must leave a
    // tombstone. The old green stays attached to the statement that earned it; that
    // statement simply left the live set.
    const evidenceAfter = await db
      .select()
      .from(testEventLatest)
      .where(eq(testEventLatest.subjectRef, ref));
    expect(evidenceAfter.length).toBe(evidenceBefore.length);

    // The superseding act itself is journalled [t-1], with the transition named.
    const journalled = await db
      .select()
      .from(specLifecycleEvents)
      .where(eq(specLifecycleEvents.acId, acId));
    expect(journalled.length).toBe(1);
    expect(journalled[0].kind).toBe("ac_status_changed");
    expect(journalled[0].fromStatus).toBe("active");
    expect(journalled[0].toStatus).toBe("superseded");

    // …and ATTRIBUTED. ac-3's claim is that a material rewrite is "a distinct,
    // ATTRIBUTED act — not the same free call as fixing a typo", and the second
    // half of that sentence is what these three columns carry. They were written
    // from the start and asserted by nothing, which is how a scope AC ends up
    // green on the weaker half of its own claim.
    expect(journalled[0].channel).toBe("rest_ui");
    expect(journalled[0].actorName).toBe("LJ Accepter");
    // WHY, in words a reviewer can read without joining back to the proposal.
    expect(journalled[0].reason).toContain("Superseded under dec-");
  });

  it("refuses to apply a proposal whose criterion moved underneath it [spec-530 dec-3]", async () => {
    tagAc(`${SPEC}/acs/ac-19`);

    const { acId, decisionId } = await seedVerifiedAc();
    const proposed = await proposeAcSupersession(
      { memexId, acId, decisionId, proposedStatement: "replacement" },
      {},
    );

    // Someone edits the criterion between propose and accept.
    await db.update(acs).set({ statement: "edited underneath" }).where(eq(acs.id, acId));

    await expect(acceptAcSupersession(memexId, proposed.comment.id, {})).rejects.toThrow(
      /changed after|re-propose/i,
    );

    // The refusal is TOTAL — nothing was half-applied.
    const row = await db.query.acs.findFirst({ where: eq(acs.id, acId) });
    expect(row!.status).toBe("active");
  });
});

describe("spec-566 t-2 — a pending proposal blocks nothing before the done-gate", () => {
  it("lets a task complete and a phase transition RUN while a supersession is outstanding", async () => {
    tagAc(`${SPEC}/acs/ac-9`);

    const { briefId, acId, decisionId } = await seedVerifiedAc();

    await proposeAcSupersession(
      { memexId, acId, decisionId, proposedStatement: "a replacement" },
      {},
    );
    // Precondition: the proposal really is outstanding. Without this the rest of
    // the test proves only that an unblocked Spec is unblocked.
    expect((await readBack(briefId, acId)).supersessionProposed).toBe(true);

    const task = await createTask(
      memexId,
      briefId,
      "some build work",
      "unrelated to the supersession",
    );
    const completed = await updateTaskStatus(memexId, task.id, "complete");
    // Assert the task ACTUALLY reached `complete` — "no error was thrown" would
    // also hold for a call that silently did nothing.
    expect(completed.status).toBe("complete");
    const taskRow = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(taskRow!.status).toBe("complete");

    // dec-1: the friction lands at the done-gate (t-7), NOWHERE earlier. Every
    // transition up to but excluding `done` must still run — asserted by reading
    // the doc's status back, not by the absence of a throw.
    for (const phase of ["specify", "build", "verify"]) {
      const moved = await updateDocStatus(memexId, briefId, phase);
      expect(moved.status).toBe(phase);
      const docRow = await db.query.documents.findFirst({ where: eq(documents.id, briefId) });
      expect(docRow!.status, `transition to ${phase} must actually land`).toBe(phase);
    }
  });
});
