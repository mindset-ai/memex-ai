// Integration tests for the t-13 decision-triggered standard drift scan (doc-10 dec-28).
//
// Covers (acceptance criteria from t-13):
//   1. Resolving a decision referenced in 2 standards → exactly 2 drift comments created
//      (one per affected standard section).
//   2. Re-resolving the same decision (resolve → reopen → resolve) does NOT duplicate
//      drift comments — idempotency by stable substring (handle + "was resolved" marker).
//   3. A decision in account A does NOT flag standards in account B (account scoping).
//   4. The drift comment body includes the dec-N handle and the "was resolved" phrase
//      so downstream UIs (t-18) can pattern-match on stable substrings.
//   5. Best-effort: resolveDecision still completes when no standard references it.
//
// Each test uses a fresh `makeTestMemex` so per-test seq numbers don't collide with
// standard references from other tests.

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { inArray, eq, and } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, decisions, tasks, docComments } from "../db/schema.js";
import { createStandard, scanForDecisionDrift } from "./standards.js";
import { createDocDraft } from "./documents.js";
import {
  createDecision,
  resolveDecision,
  reopenDecision,
} from "./decisions.js";
import { listComments } from "./comments.js";
import { makeTestMemex } from "./test-helpers.js";

const createdDocIds: string[] = [];

afterAll(async () => {
  if (createdDocIds.length) {
    await db
      .delete(tasks)
      .where(inArray(tasks.docId, createdDocIds))
      .catch(() => {});
    await db
      .delete(decisions)
      .where(inArray(decisions.docId, createdDocIds))
      .catch(() => {});
    await db
      .delete(documents)
      .where(inArray(documents.id, createdDocIds))
      .catch(() => {});
  }
});

async function countDriftCommentsOnSection(
  memexId: string,
  sectionId: string,
): Promise<number> {
  const all = await listComments(memexId, sectionId);
  return all.filter((c) => c.commentType === "drift").length;
}

describe("decision-triggered drift scan (resolveDecision side-effect)", () => {
  it("creates exactly 2 drift comments when a decision is referenced in 2 standards", async () => {
    const memexId = await makeTestMemex("drift-2bp");
    const spec = await createDocDraft(
      memexId,
      "DriftStrat-A",
      "purpose",
      "spec",
    );
    createdDocIds.push(spec.id);
    const dec = await createDecision(memexId, spec.id, "Pick cache backend");
    const handle = `dec-${dec.seq}`;

    const bp1 = await createStandard(memexId, {
      title: "Caching-A",
      sections: [
        { sectionType: "do", content: `Use write-through cache [per ${handle}].` },
      ],
    });
    createdDocIds.push(bp1.id);

    const bp2 = await createStandard(memexId, {
      title: "Deployment-A",
      sections: [
        { sectionType: "verify", content: `Cache routing per [per ${handle}].` },
      ],
    });
    createdDocIds.push(bp2.id);

    // A standard that does NOT reference the decision — must be untouched.
    const bpUnrelated = await createStandard(memexId, {
      title: "Routing-A",
      sections: [{ sectionType: "do", content: "Use Envoy [per dec-9999]." }],
    });
    createdDocIds.push(bpUnrelated.id);

    await resolveDecision(memexId, dec.id, "Use Redis with write-through");

    // bp1 + bp2 each get one drift comment on the matching section.
    const bp1Section = bp1.sections.find((s) => s.sectionType === "do")!;
    const bp2Section = bp2.sections.find((s) => s.sectionType === "verify")!;
    const bpUnrelatedSection = bpUnrelated.sections.find(
      (s) => s.sectionType === "do",
    )!;

    expect(await countDriftCommentsOnSection(memexId, bp1Section.id)).toBe(1);
    expect(await countDriftCommentsOnSection(memexId, bp2Section.id)).toBe(1);
    expect(
      await countDriftCommentsOnSection(memexId, bpUnrelatedSection.id),
    ).toBe(0);

    const bp1Comments = await listComments(memexId, bp1Section.id);
    const drift = bp1Comments.find((c) => c.commentType === "drift")!;
    // Stable substrings the UI / t-18 / re-resolve idempotency path will pattern-match on.
    expect(drift.content).toContain(handle);
    expect(drift.content).toContain("was resolved");
    expect(drift.content).toContain("Pick cache backend");
    expect(drift.source).toBe("agent");
  });

  it("re-resolving the same decision does not duplicate drift comments", async () => {
    const memexId = await makeTestMemex("drift-reresolve");
    const spec = await createDocDraft(
      memexId,
      "DriftStrat-B",
      "purpose",
      "spec",
    );
    createdDocIds.push(spec.id);
    const dec = await createDecision(memexId, spec.id, "Original title");
    const handle = `dec-${dec.seq}`;

    const bp = await createStandard(memexId, {
      title: "ReResolveTarget",
      sections: [
        { sectionType: "do", content: `Always [per ${handle}] something.` },
      ],
    });
    createdDocIds.push(bp.id);
    const sectionId = bp.sections[0].id;

    // First resolve → one drift comment.
    await resolveDecision(memexId, dec.id, "First resolution");
    expect(await countDriftCommentsOnSection(memexId, sectionId)).toBe(1);

    // Reopen + resolve again → must NOT duplicate. The idempotency check matches on
    // handle + "was resolved" marker, not full body, so even if the title were edited
    // between the two resolves the dedup would still hold.
    await reopenDecision(memexId, dec.id);
    await resolveDecision(memexId, dec.id, "Second resolution after reopen");

    expect(await countDriftCommentsOnSection(memexId, sectionId)).toBe(1);
  });

  it("resolves cleanly when no standard references the decision (no-op scan)", async () => {
    const memexId = await makeTestMemex("drift-noop");
    const spec = await createDocDraft(
      memexId,
      "DriftStrat-C",
      "purpose",
      "spec",
    );
    createdDocIds.push(spec.id);
    const dec = await createDecision(memexId, spec.id, "Unreferenced");

    // No standard mentions this decision. resolveDecision must complete and the
    // resolved status must persist; no drift comments should be inserted anywhere.
    const resolved = await resolveDecision(memexId, dec.id, "Done");
    expect(resolved.status).toBe("resolved");

    // Confirm at the row level — no drift comments newly attached to standards in this
    // (fresh) account that mention this decision's handle.
    const handle = `dec-${dec.seq}`;
    const allDriftInAccount = await db.query.docComments.findMany({
      where: and(
        eq(docComments.memexId, memexId),
        eq(docComments.commentType, "drift"),
      ),
    });
    const referencingThis = allDriftInAccount.filter((c) =>
      (c.content ?? "").includes(handle),
    );
    expect(referencingThis).toHaveLength(0);
  });

  it("does not flag standards in a different account", async () => {
    // The "victim" account has a standard that references dec-1.
    const victimAccount = await makeTestMemex("drift-victim");
    const victimBp = await createStandard(victimAccount, {
      title: "VictimBp",
      sections: [{ sectionType: "do", content: "rule [per dec-1]" }],
    });
    createdDocIds.push(victimBp.id);
    const victimSectionId = victimBp.sections[0].id;

    // The "actor" account has its own decision dec-1 in a fresh spec; resolving
    // it must NOT touch the victim standard, even though the literal handle text
    // matches.
    const actorAccount = await makeTestMemex("drift-actor");
    const spec = await createDocDraft(
      actorAccount,
      "DriftStrat-X",
      "purpose",
      "spec",
    );
    createdDocIds.push(spec.id);
    const dec = await createDecision(actorAccount, spec.id, "Actor's question");
    const actorHandle = `dec-${dec.seq}`;

    await resolveDecision(actorAccount, dec.id, "Actor resolution");

    // No drift comment created on the victim's section, even though the handle text
    // matches — because the FTS scan is account-scoped to the actor.
    const victimComments = await listComments(victimAccount, victimSectionId);
    const victimDrift = victimComments.filter((c) => c.commentType === "drift");
    expect(
      victimDrift.filter((c) => (c.content ?? "").includes(actorHandle)),
    ).toHaveLength(0);
  });

  it("scanForDecisionDrift returns the correct count and is idempotent on direct call", async () => {
    const memexId = await makeTestMemex("drift-direct");
    const spec = await createDocDraft(
      memexId,
      "DriftStrat-D",
      "purpose",
      "spec",
    );
    createdDocIds.push(spec.id);
    const dec = await createDecision(memexId, spec.id, "Direct call");
    const handle = `dec-${dec.seq}`;

    const bp1 = await createStandard(memexId, {
      title: "DirectScan-1",
      sections: [{ sectionType: "do", content: `rule one [per ${handle}]` }],
    });
    createdDocIds.push(bp1.id);

    const bp2 = await createStandard(memexId, {
      title: "DirectScan-2",
      sections: [
        { sectionType: "do", content: `rule two [per ${handle}]` },
        { sectionType: "verify", content: `verification [per ${handle}]` },
      ],
    });
    createdDocIds.push(bp2.id);

    const result = await scanForDecisionDrift(memexId, handle, "Direct call");
    expect(result.standardsFlagged).toBe(2);
    // bp1 has 1 matching section; bp2 has 2 matching sections — 3 sections flagged total.
    expect(result.sectionsFlagged).toBe(3);

    // Subsequent direct call is a no-op due to idempotency.
    const second = await scanForDecisionDrift(memexId, handle, "Direct call");
    expect(second.standardsFlagged).toBe(0);
    expect(second.sectionsFlagged).toBe(0);
  });
});
