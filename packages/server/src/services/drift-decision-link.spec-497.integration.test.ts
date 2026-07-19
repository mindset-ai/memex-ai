// spec-497 dec-3 (t-1/t-2/t-3) — the first-class drift→decision link.
//
// Drift comments used to carry the triggering decision only inside their prose; this
// Spec stamps a real `doc_comments.drift_decision_id` FK so the knowledge-graph
// endpoint can draw decision→standard drift edges from a column. These tests prove:
//   ac-7  the column exists, is a real FK, and ON DELETE SET NULL degrades the link
//         (deleting the decision keeps the drift comment, just nulls the link).
//   ac-8  BOTH write paths stamp it: the auto scanForDecisionDrift path (end-to-end
//         via resolveDecision) and the explicit flagDrift(... driftDecisionId) path
//         the flag_drift MCP handler uses after resolving decisionRef.
//   ac-9  the backfill re-derives the link from historical prose (seq+title), leaves
//         unparseable/ambiguous rows NULL, and the body↔parser marker stays in sync.

import { describe, it, expect, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, decisions, tasks, docComments } from "../db/schema.js";
import {
  createStandard,
  flagDrift,
  scanForDecisionDrift,
  backfillDriftDecisionLinks,
  driftCommentBody,
  parseDriftDecisionHandle,
  parseDriftDecisionRef,
  DRIFT_COMMENT_RESOLVED_MARKER,
} from "./standards.js";
import { createDocDraft } from "./documents.js";
import { createDecision, resolveDecision } from "./decisions.js";
import { listComments } from "./comments.js";
import { makeTestMemex } from "./test-helpers.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-497";
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;

const createdDocIds: string[] = [];

afterAll(async () => {
  if (createdDocIds.length) {
    await db.delete(tasks).where(inArray(tasks.docId, createdDocIds)).catch(() => {});
    await db.delete(decisions).where(inArray(decisions.docId, createdDocIds)).catch(() => {});
    await db.delete(documents).where(inArray(documents.id, createdDocIds)).catch(() => {});
  }
});

async function driftCommentOn(memexId: string, sectionId: string) {
  const all = await listComments(memexId, sectionId);
  return all.find((c) => c.commentType === "drift");
}

describe("drift→decision link — schema + FK (ac-7)", () => {
  it("stamps a real decision FK and ON DELETE SET NULL degrades the link without deleting the drift (ac-7)", async () => {
    tagAc(AC(7));
    const memexId = await makeTestMemex("dfk");
    const spec = await createDocDraft(memexId, "FK-spec", "purpose", "spec");
    createdDocIds.push(spec.id);
    const dec = await createDecision(memexId, spec.id, "Choose FK behaviour");

    const std = await createStandard(memexId, {
      title: "FK-standard",
      sections: [{ sectionType: "do", content: "A rule." }],
    });
    createdDocIds.push(std.id);
    const section = std.sections.find((s) => s.sectionType === "do")!;

    // Stamp the link directly through flagDrift.
    await flagDrift(memexId, section.id, "observed drift", { driftDecisionId: dec.id });
    const stamped = await driftCommentOn(memexId, section.id);
    expect(stamped?.driftDecisionId).toBe(dec.id);

    // Deleting the decision must NULL the link, not cascade-delete the drift comment.
    await db.delete(decisions).where(eq(decisions.id, dec.id));
    const afterDelete = await driftCommentOn(memexId, section.id);
    expect(afterDelete).toBeDefined();
    expect(afterDelete?.driftDecisionId).toBeNull();
  });
});

describe("both write paths stamp drift_decision_id (ac-8)", () => {
  it("auto path: resolving a decision cited by a standard stamps the triggering decision (ac-8)", async () => {
    tagAc(AC(8));
    const memexId = await makeTestMemex("dauto");
    const spec = await createDocDraft(memexId, "Auto-spec", "purpose", "spec");
    createdDocIds.push(spec.id);
    const dec = await createDecision(memexId, spec.id, "Pick cache backend");
    const handle = `dec-${dec.seq}`;

    const std = await createStandard(memexId, {
      title: "Auto-standard",
      sections: [{ sectionType: "do", content: `Use write-through [per ${handle}].` }],
    });
    createdDocIds.push(std.id);
    const section = std.sections.find((s) => s.sectionType === "do")!;

    // resolveDecision fires the post-commit scan (awaited), which stamps the id.
    await resolveDecision(memexId, dec.id, "Use Redis");

    const drift = await driftCommentOn(memexId, section.id);
    expect(drift?.driftDecisionId).toBe(dec.id);
    // The prose still carries the handle (idempotency + human readability).
    expect(drift?.content).toContain(handle);
  });

  it("explicit path: flagDrift with a driftDecisionId stamps it; without one it stays NULL (ac-8)", async () => {
    tagAc(AC(8));
    const memexId = await makeTestMemex("dexpl");
    const spec = await createDocDraft(memexId, "Expl-spec", "purpose", "spec");
    createdDocIds.push(spec.id);
    const dec = await createDecision(memexId, spec.id, "Explicit link choice");

    const stdLinked = await createStandard(memexId, {
      title: "Expl-standard-linked",
      sections: [{ sectionType: "do", content: "Linked rule." }],
    });
    createdDocIds.push(stdLinked.id);
    const linkedSection = stdLinked.sections.find((s) => s.sectionType === "do")!;
    await flagDrift(memexId, linkedSection.id, "linked drift", { driftDecisionId: dec.id });
    expect((await driftCommentOn(memexId, linkedSection.id))?.driftDecisionId).toBe(dec.id);

    // No decisionRef → human-observed drift with no single trigger stays NULL (badge-only).
    const stdBare = await createStandard(memexId, {
      title: "Expl-standard-bare",
      sections: [{ sectionType: "do", content: "Bare rule." }],
    });
    createdDocIds.push(stdBare.id);
    const bareSection = stdBare.sections.find((s) => s.sectionType === "do")!;
    await flagDrift(memexId, bareSection.id, "unattributed drift");
    expect((await driftCommentOn(memexId, bareSection.id))?.driftDecisionId).toBeNull();
  });
});

describe("historical backfill + marker sync (ac-9)", () => {
  it("re-links a historical drift comment via seq+title, leaving ambiguous/unparseable rows NULL (ac-9)", async () => {
    tagAc(AC(9));
    const memexId = await makeTestMemex("dbf");
    const spec = await createDocDraft(memexId, "BF-spec", "purpose", "spec");
    createdDocIds.push(spec.id);
    const dec = await createDecision(memexId, spec.id, "Backfillable choice");
    const handle = `dec-${dec.seq}`;

    const std = await createStandard(memexId, {
      title: "BF-standard",
      sections: [
        { sectionType: "do", content: `Rule one [per ${handle}].` },
        { sectionType: "verify", content: "Rule two, human-flagged." },
      ],
    });
    createdDocIds.push(std.id);
    const linkedSection = std.sections.find((s) => s.sectionType === "do")!;
    const bareSection = std.sections.find((s) => s.sectionType === "verify")!;

    // Simulate a PRE-Spec drift comment: correct body, but drift_decision_id NULL.
    await flagDrift(memexId, linkedSection.id, driftCommentBody(handle, dec.title));
    // And a human-authored drift with no decision reference at all.
    await flagDrift(memexId, bareSection.id, "This rule looks stale.");

    // Sanity: both start NULL.
    const before = await db
      .select()
      .from(docComments)
      .where(and(eq(docComments.memexId, memexId), eq(docComments.commentType, "drift"), isNull(docComments.driftDecisionId)));
    expect(before.length).toBe(2);

    const result = await backfillDriftDecisionLinks(memexId);
    expect(result.linked).toBe(1);
    expect(result.unresolved).toBe(1);

    expect((await driftCommentOn(memexId, linkedSection.id))?.driftDecisionId).toBe(dec.id);
    expect((await driftCommentOn(memexId, bareSection.id))?.driftDecisionId).toBeNull();

    // Idempotent: a second run touches nothing (all resolvable rows already linked).
    const second = await backfillDriftDecisionLinks(memexId);
    expect(second.linked).toBe(0);
  });

  it("driftCommentBody round-trips through both parsers and carries the marker (ac-9)", () => {
    tagAc(AC(9));
    const body = driftCommentBody("dec-42", 'A "quoted" choice about caching');
    expect(body).toContain(DRIFT_COMMENT_RESOLVED_MARKER);
    // The write format and the read parser share one shape — a copy edit that breaks
    // them apart fails HERE rather than silently zeroing historical drift edges.
    expect(parseDriftDecisionHandle(body)).toBe("dec-42");
    const ref = parseDriftDecisionRef(driftCommentBody("dec-7", "Plain title"));
    expect(ref).toEqual({ seq: 7, title: "Plain title" });
    // Non-matching / human bodies parse to null.
    expect(parseDriftDecisionHandle("This rule looks stale.")).toBeNull();
    expect(parseDriftDecisionRef("Some unrelated comment.")).toBeNull();
  });
});
