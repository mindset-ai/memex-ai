import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, docSections, decisions, tasks } from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import { createDecision } from "./decisions.js";
import { createTask } from "./tasks.js";
import { createAc } from "./acs.js";
import { addComment, addDecisionComment } from "./comments.js";
import { getDoc } from "./documents.js";
import {
  cutVersion,
  getVersionSnapshot,
  restoreVersion,
  CARRY_FORWARD_CLASSES,
  type ArtifactSnapshot,
} from "./versioning.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import { makeTestMemex } from "./test-helpers.js";

// spec-448 t-2/t-3/t-4: version-cut, view-as-of, and rollback service tests.
const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-448/acs/ac-${n}`;

const createdDocIds: string[] = [];

afterAll(async () => {
  for (const id of createdDocIds) {
    await db.delete(documents).where(eq(documents.id, id)).catch(() => {});
  }
});

let memexId: string;
let otherMemexId: string;
beforeAll(async () => {
  memexId = await makeTestMemex("dv");
  otherMemexId = await makeTestMemex("dv-other");
});

async function readDocVersion(docId: string): Promise<number> {
  const [row] = await db.select({ version: documents.version }).from(documents).where(eq(documents.id, docId));
  return row!.version;
}

describe("cutVersion (t-2)", () => {
  it("inserts an immutable document_versions row with a full-graph snapshot + checksum, and increments documents.version by exactly one (ac-11, ac-14)", async () => {
    tagAc(AC(11));
    tagAc(AC(14));

    const doc = await createDocDraft(memexId, "Cut Version Doc", "Purpose text");
    createdDocIds.push(doc.id);
    await createDecision(memexId, doc.id, "A decision");
    await createTask(memexId, doc.id, "A task", "Task description");
    await createAc({ memexId, briefId: doc.id, kind: "scope", statement: "Some outcome" });

    const before = await readDocVersion(doc.id);
    expect(before).toBe(1);

    const cut = await cutVersion(memexId, doc.id, "V1 snapshot", CARRY_FORWARD_CLASSES);

    expect(cut.versionNumber).toBe(1);
    expect(cut.name).toBe("V1 snapshot");
    expect(cut.checksum).toBeTruthy();
    const snap = cut.snapshot as ArtifactSnapshot;
    expect(snap.sections.length).toBeGreaterThanOrEqual(1);
    expect(snap.decisions.length).toBe(1);
    expect(snap.tasks.length).toBe(1);
    expect(snap.acs.length).toBe(1);

    const after = await readDocVersion(doc.id);
    expect(after).toBe(before + 1);

    // Reconstructable without live tables (ac-11): the snapshot alone carries
    // the full graph's content.
    expect(snap.decisions[0].title).toBe("A decision");
    expect(snap.tasks[0].title).toBe("A task");
  });

  it("rejects an empty name; allows duplicate names across cuts (ac-15)", async () => {
    tagAc(AC(15));

    const doc = await createDocDraft(memexId, "Name Validation Doc", "Purpose text");
    createdDocIds.push(doc.id);

    await expect(cutVersion(memexId, doc.id, "", CARRY_FORWARD_CLASSES)).rejects.toThrow(ValidationError);
    await expect(cutVersion(memexId, doc.id, "   ", CARRY_FORWARD_CLASSES)).rejects.toThrow(ValidationError);

    const first = await cutVersion(memexId, doc.id, "Same name", CARRY_FORWARD_CLASSES);
    const second = await cutVersion(memexId, doc.id, "Same name", CARRY_FORWARD_CLASSES);
    expect(first.name).toBe("Same name");
    expect(second.name).toBe("Same name");
    expect(second.versionNumber).toBe(first.versionNumber + 1);
  });

  it("stamps retired_at_version=N on classes NOT carried forward; carried-forward classes are untouched (ac-17, ac-19)", async () => {
    tagAc(AC(17));
    tagAc(AC(19));

    const doc = await createDocDraft(memexId, "Carry Forward Doc", "Purpose text");
    createdDocIds.push(doc.id);
    const decision = await createDecision(memexId, doc.id, "Kept decision");
    const task = await createTask(memexId, doc.id, "Left-behind task", "Task description");

    const cut = await cutVersion(memexId, doc.id, "Prune tasks", ["decisions", "acs", "issues", "comments"]);

    const [decisionRow] = await db.select().from(decisions).where(eq(decisions.id, decision.id));
    const [taskRow] = await db.select().from(tasks).where(eq(tasks.id, task.id));

    expect(decisionRow!.retiredAtVersion).toBeNull();
    expect(taskRow!.retiredAtVersion).toBe(cut.versionNumber);
  });

  it("is doc-type-agnostic — accepts a non-spec docType (ac-34)", async () => {
    tagAc(AC(34));

    const doc = await createDocDraft(memexId, "Generic Doc", "Purpose text", "document");
    createdDocIds.push(doc.id);

    const cut = await cutVersion(memexId, doc.id, "V1", CARRY_FORWARD_CLASSES);
    expect(cut.versionNumber).toBe(1);
  });

  it("stamps each snapshot comment with the documents.version active at its original write time (ac-24)", async () => {
    tagAc(AC(24));

    const doc = await createDocDraft(memexId, "Comment Version Doc", "Purpose text");
    createdDocIds.push(doc.id);
    const sectionId = doc.sections[0].id;

    const c1 = await addComment(memexId, sectionId, "Alice", "Written at v1");
    await cutVersion(memexId, doc.id, "V1", CARRY_FORWARD_CLASSES); // doc.version: 1 -> 2

    const c2 = await addComment(memexId, sectionId, "Bob", "Written at v2");
    const cut2 = await cutVersion(memexId, doc.id, "V2", CARRY_FORWARD_CLASSES); // 2 -> 3

    const snap = cut2.snapshot as ArtifactSnapshot;
    const snapC1 = snap.comments.find((c) => c.id === c1.id);
    const snapC2 = snap.comments.find((c) => c.id === c2.id);
    expect(snapC1?.versionAtWrite).toBe(1);
    expect(snapC2?.versionAtWrite).toBe(2);
  });
});

describe("getVersionSnapshot (t-3)", () => {
  it("live get_doc excludes retired-at-version sections; the snapshot read includes them (ac-18)", async () => {
    tagAc(AC(18));

    const doc = await createDocDraft(memexId, "Retired Section Doc", "Purpose text", "spec", undefined, {
      bodySections: [{ title: "Extra section", content: "Extra content" }],
    });
    createdDocIds.push(doc.id);
    expect(doc.sections.length).toBe(2);

    const cut = await cutVersion(memexId, doc.id, "V1", CARRY_FORWARD_CLASSES);
    const extraSectionId = doc.sections[1].id;

    // Simulate a section being retired (out of cutVersion's own scope — narrative
    // sections always carry per t-2 — but the READ filter must still honour the
    // column defensively, and this proves it).
    await db
      .update(docSections)
      .set({ retiredAtVersion: cut.versionNumber })
      .where(eq(docSections.id, extraSectionId));

    const live = await getDoc(memexId, doc.id);
    expect(live.sections.some((s) => s.id === extraSectionId)).toBe(false);

    const snapshot = await getVersionSnapshot(memexId, doc.id, cut.versionNumber);
    const snap = snapshot.snapshot as ArtifactSnapshot;
    expect(snap.sections.some((s) => s.id === extraSectionId)).toBe(true);
  });

  it("renders as-of vK comments against vK's section text, not the live (edited) text (ac-25)", async () => {
    tagAc(AC(25));

    const doc = await createDocDraft(memexId, "As-Of Rendering Doc", "Original overview text");
    createdDocIds.push(doc.id);
    const sectionId = doc.sections[0].id;
    await addComment(memexId, sectionId, "Alice", "Comment about the original text");

    const cut = await cutVersion(memexId, doc.id, "V1", CARRY_FORWARD_CLASSES);

    // Live edit AFTER the cut — the snapshot must not reflect this.
    await db.update(docSections).set({ content: "Edited overview text" }).where(eq(docSections.id, sectionId));

    const snapshot = await getVersionSnapshot(memexId, doc.id, cut.versionNumber);
    const snap = snapshot.snapshot as ArtifactSnapshot;
    const snapSection = snap.sections.find((s) => s.id === sectionId);
    const snapComment = snap.comments.find((c) => c.sectionId === sectionId);

    expect(snapSection?.content).toBe("Original overview text");
    expect(snapComment?.content).toBe("Comment about the original text");

    const liveSection = await getDoc(memexId, doc.id);
    expect(liveSection.sections.find((s) => s.id === sectionId)?.content).toBe("Edited overview text");
  });

  it("returns 404 (not 403) for a cross-tenant or unknown version read (std-7)", async () => {
    const doc = await createDocDraft(memexId, "Unauthorized Read Doc", "Purpose text");
    createdDocIds.push(doc.id);
    const cut = await cutVersion(memexId, doc.id, "V1", CARRY_FORWARD_CLASSES);

    await expect(getVersionSnapshot(otherMemexId, doc.id, cut.versionNumber)).rejects.toThrow(NotFoundError);
    await expect(getVersionSnapshot(memexId, doc.id, 999)).rejects.toThrow(NotFoundError);
  });
});

describe("restoreVersion (t-4)", () => {
  it("auto-freezes current state first, then materialises a higher version equal to the source, recording restored_from_version, with doc id/handle/status unchanged (ac-20, ac-21, ac-22, ac-23)", async () => {
    tagAc(AC(20));
    tagAc(AC(21));
    tagAc(AC(22));
    tagAc(AC(23));

    const doc = await createDocDraft(memexId, "Restore Doc", "Purpose text");
    createdDocIds.push(doc.id);
    const original = await createDecision(memexId, doc.id, "Original decision");
    await addDecisionComment(memexId, original.id, "Alice", "Discussing the original decision");

    const v1 = await cutVersion(memexId, doc.id, "V1", CARRY_FORWARD_CLASSES); // documents.version: 1 -> 2
    expect(v1.versionNumber).toBe(1);

    // Diverge the live graph after the cut.
    await createDecision(memexId, doc.id, "Added after v1");

    const versionBeforeRestore = await readDocVersion(doc.id); // 2
    const [docBefore] = await db.select().from(documents).where(eq(documents.id, doc.id));

    const restored = await restoreVersion(memexId, doc.id, v1.versionNumber);

    // ac-22: provenance.
    expect(restored.restoredFromVersion).toBe(v1.versionNumber);
    // ac-21: content equals the source snapshot exactly, and the version number
    // only ever increases (auto-freeze bumps once, the restore cut bumps again).
    expect(restored.checksum).toBe(v1.checksum);
    expect(restored.versionNumber).toBeGreaterThan(versionBeforeRestore);

    const versionAfterRestore = await readDocVersion(doc.id);
    expect(versionAfterRestore).toBe(versionBeforeRestore + 2);

    // An intermediate auto-freeze version exists carrying the PRE-restore
    // (diverged) state — nothing is lost (ac-20).
    const autoFreeze = await getVersionSnapshot(memexId, doc.id, versionBeforeRestore);
    const autoFreezeSnap = autoFreeze.snapshot as ArtifactSnapshot;
    expect(autoFreezeSnap.decisions.some((d) => d.title === "Added after v1")).toBe(true);

    // Live (non-retired) content now matches v1's content — the divergent
    // decision is left BEHIND (retired_at_version stamped), never hard-deleted
    // (b-97 dec-2's soft-delete-only posture, kept uniformly for restore too).
    const allDecisions = await db.select().from(decisions).where(eq(decisions.docId, doc.id));
    const liveDecisions = allDecisions.filter((d) => d.retiredAtVersion === null);
    expect(liveDecisions.length).toBe(1);
    expect(liveDecisions[0]!.title).toBe("Original decision");

    const divergent = allDecisions.find((d) => d.title === "Added after v1");
    expect(divergent).toBeDefined();
    expect(divergent!.retiredAtVersion).toBe(v1.versionNumber);

    // ac-23: identity unchanged.
    const [docAfter] = await db.select().from(documents).where(eq(documents.id, doc.id));
    expect(docAfter!.id).toBe(docBefore!.id);
    expect(docAfter!.handle).toBe(docBefore!.handle);
    expect(docAfter!.status).toBe(docBefore!.status);
  });
});
