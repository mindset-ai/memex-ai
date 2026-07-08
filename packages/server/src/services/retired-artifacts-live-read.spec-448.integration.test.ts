// spec-448 t-6 gap closure — ac-18 says "A retired-at-version-N artifact is
// excluded from the live doc read ... but is included when reading the
// version snapshot(s) it belonged to." The t-2/t-3/t-4 agent wired that filter
// into get_doc's SECTION read only (documents.ts); this file proves the SAME
// exclusion holds for every other prunable artifact class — decisions, tasks,
// ACs, issues, and comments — closing the gap in their LIVE list/read
// functions (decisions.ts/tasks.ts/acs.ts/issues.ts/comments.ts), while the
// version-snapshot read keeps including them verbatim (never a delete, dec-2).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents } from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import { createDecision, listDecisions } from "./decisions.js";
import { createTask, listTasks } from "./tasks.js";
import { createAc, listAcsForBrief, listAcsForBriefWithVerification } from "./acs.js";
import { createIssue, listIssuesForSpec } from "./issues.js";
import { addComment, listComments } from "./comments.js";
import { cutVersion, getVersionSnapshot, type ArtifactSnapshot } from "./versioning.js";
import { makeTestMemex } from "./test-helpers.js";

const AC_18 = "mindset-prod/memex-building-itself/specs/spec-448/acs/ac-18";

const createdDocIds: string[] = [];
afterAll(async () => {
  for (const id of createdDocIds) {
    await db.delete(documents).where(eq(documents.id, id)).catch(() => {});
  }
});

let memexId: string;
beforeAll(async () => {
  // std-37: per-worker-unique prefix so parallel test workers never collide.
  memexId = await makeTestMemex(`rag-${process.pid}`);
});

describe("spec-448 t-6 gap closure: retired-at-version excluded from live LIST reads (ac-18)", () => {
  it("decisions: retired from listDecisions live read, present in the version snapshot", async () => {
    tagAc(AC_18);
    const doc = await createDocDraft(memexId, "Gap Closure Decision Doc", "Purpose text");
    createdDocIds.push(doc.id);
    const decision = await createDecision(memexId, doc.id, "To be retired");

    // carryForward=[] retires every prunable class at this cut.
    const cut = await cutVersion(memexId, doc.id, "V1", []);

    const live = await listDecisions(memexId, doc.id);
    expect(live.some((d) => d.id === decision.id)).toBe(false);

    const snapshot = await getVersionSnapshot(memexId, doc.id, cut.versionNumber);
    const snap = snapshot.snapshot as ArtifactSnapshot;
    expect(snap.decisions.some((d) => d.id === decision.id)).toBe(true);
  });

  it("tasks: retired from listTasks live read, present in the version snapshot", async () => {
    tagAc(AC_18);
    const doc = await createDocDraft(memexId, "Gap Closure Task Doc", "Purpose text");
    createdDocIds.push(doc.id);
    const task = await createTask(memexId, doc.id, "To be retired", "Task description");

    const cut = await cutVersion(memexId, doc.id, "V1", []);

    const live = await listTasks(memexId, doc.id);
    expect(live.some((t) => t.id === task.id)).toBe(false);

    const snapshot = await getVersionSnapshot(memexId, doc.id, cut.versionNumber);
    const snap = snapshot.snapshot as ArtifactSnapshot;
    expect(snap.tasks.some((t) => t.id === task.id)).toBe(true);
  });

  it("acs: retired from listAcsForBrief AND listAcsForBriefWithVerification (the AC-tab read), present in the version snapshot", async () => {
    tagAc(AC_18);
    const doc = await createDocDraft(memexId, "Gap Closure AC Doc", "Purpose text");
    createdDocIds.push(doc.id);
    const ac = await createAc({ memexId, briefId: doc.id, kind: "scope", statement: "To be retired" });

    const cut = await cutVersion(memexId, doc.id, "V1", []);

    const live = await listAcsForBrief(memexId, doc.id);
    expect(live.some((a) => a.id === ac.id)).toBe(false);

    const liveWithVerification = await listAcsForBriefWithVerification(memexId, doc.id);
    expect(liveWithVerification.some((a) => a.ac.id === ac.id)).toBe(false);

    const snapshot = await getVersionSnapshot(memexId, doc.id, cut.versionNumber);
    const snap = snapshot.snapshot as ArtifactSnapshot;
    expect(snap.acs.some((a) => a.id === ac.id)).toBe(true);
  });

  it("issues: retired from listIssuesForSpec live read, present in the version snapshot", async () => {
    tagAc(AC_18);
    const doc = await createDocDraft(memexId, "Gap Closure Issue Doc", "Purpose text");
    createdDocIds.push(doc.id);
    const issue = await createIssue({
      memexId,
      docId: doc.id,
      title: "To be retired",
      body: "Issue body",
      type: "bug",
    });

    const cut = await cutVersion(memexId, doc.id, "V1", []);

    const live = await listIssuesForSpec(memexId, doc.id);
    expect(live.some((i) => i.id === issue.id)).toBe(false);

    const snapshot = await getVersionSnapshot(memexId, doc.id, cut.versionNumber);
    const snap = snapshot.snapshot as ArtifactSnapshot;
    expect(snap.issues.some((i) => i.id === issue.id)).toBe(true);
  });

  it("comments: retired from listComments live read, present in the version snapshot", async () => {
    tagAc(AC_18);
    const doc = await createDocDraft(memexId, "Gap Closure Comment Doc", "Purpose text");
    createdDocIds.push(doc.id);
    const sectionId = doc.sections[0].id;
    const comment = await addComment(memexId, sectionId, "Alice", "To be retired");

    const cut = await cutVersion(memexId, doc.id, "V1", []);

    const live = await listComments(memexId, sectionId);
    expect(live.some((c) => c.id === comment.id)).toBe(false);

    const snapshot = await getVersionSnapshot(memexId, doc.id, cut.versionNumber);
    const snap = snapshot.snapshot as ArtifactSnapshot;
    expect(snap.comments.some((c) => c.id === comment.id)).toBe(true);
  });
});
