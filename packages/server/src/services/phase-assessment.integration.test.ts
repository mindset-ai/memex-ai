import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, decisions, tasks, docComments, issues } from "../db/schema.js";
import { createDocDraft, updateDocStatus } from "./documents.js";
import { createDecision, resolveDecision } from "./decisions.js";
import { createTask, updateTaskStatus } from "./tasks.js";
import { addComment, addTaskComment } from "./comments.js";
import { createIssue, convertIssueToTask, updateIssueStatus } from "./issues.js";
import {
  assessPhaseTransition,
  formatPhaseAssessment,
  detectMissingCoreLenses,
  wasRecentlyAssessed,
  _clearRecentAssessments,
} from "./phase-assessment.js";
import { addSection } from "./sections.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import { makeTestMemex } from "./test-helpers.js";
import { tagAc } from "@memex-ai-ac/vitest";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-106";

const createdDocIds: string[] = [];

afterAll(async () => {
  for (const id of createdDocIds) {
    await db.delete(docComments).where(eq(docComments.memexId, memexId)).catch(() => {});
    await db.delete(issues).where(eq(issues.docId, id)).catch(() => {});
    await db.delete(tasks).where(eq(tasks.docId, id)).catch(() => {});
    await db.delete(decisions).where(eq(decisions.docId, id)).catch(() => {});
    await db.delete(documents).where(eq(documents.id, id)).catch(() => {});
  }
});

let memexId: string;
beforeAll(async () => {
  memexId = await makeTestMemex();
});

beforeEach(() => {
  _clearRecentAssessments();
});

describe("assessPhaseTransition", () => {
  it("returns NotFoundError for an unknown specId", async () => {
    await expect(
      assessPhaseTransition(memexId, "00000000-0000-0000-0000-000000000000", "build"),
    ).rejects.toThrow(NotFoundError);
  });

  it("rejects non-Spec docTypes", async () => {
    const doc = await createDocDraft(memexId, "Document doc", "Purpose", "document");
    createdDocIds.push(doc.id);
    await expect(assessPhaseTransition(memexId, doc.id, "build")).rejects.toThrow(
      ValidationError,
    );
  });

  it("returns rubricNote for specify target and the composed draft→specify rubric prose", async () => {
    const spec = await createDocDraft(memexId, "Specify target", "Purpose", "spec");
    createdDocIds.push(spec.id);
    const result = await assessPhaseTransition(memexId, spec.id, "specify");
    expect(result.targetPhase).toBe("specify");
    // b-68 t-5 / t-7: legacy `rubric` field removed. `rubricProse` now picks up
    // the draft→specify TransitionRubric from BASE_SCAFFOLD.transitions, and
    // `rubricNote` keeps the original soft-rubric line.
    expect(result.rubricProse).toMatch(/Draft-to-specify readiness review/i);
    expect(result.rubricNote).toMatch(/no readiness review/i);
    expect(result.transition).toBe("draft → specify");
  });

  it("loads specify-to-build rubric for build target", async () => {
    const spec = await createDocDraft(memexId, "Build target", "Purpose", "spec");
    createdDocIds.push(spec.id);
    const result = await assessPhaseTransition(memexId, spec.id, "build");
    // b-68 t-7: rubric prose is now sourced from BASE_SCAFFOLD.transitions via
    // `toRubric` rather than `phases/<src>/transitions.md`.
    expect(result.rubricProse.length).toBeGreaterThan(0);
    expect(result.rubricProse).toMatch(/specify/i);
  });

  it("loads build-to-verify rubric for verify target", async () => {
    const spec = await createDocDraft(memexId, "Verify target", "Purpose", "spec");
    createdDocIds.push(spec.id);
    const result = await assessPhaseTransition(memexId, spec.id, "verify");
    expect(result.rubricProse.length).toBeGreaterThan(0);
    expect(result.rubricProse).toMatch(/verify/i);
  });

  it("loads verify-to-done rubric for done target", async () => {
    const spec = await createDocDraft(memexId, "Done target", "Purpose", "spec");
    createdDocIds.push(spec.id);
    const result = await assessPhaseTransition(memexId, spec.id, "done");
    expect(result.rubricProse.length).toBeGreaterThan(0);
  });

  it("returns clean facts when nothing is open", async () => {
    const spec = await createDocDraft(memexId, "Clean facts", "Purpose", "spec");
    createdDocIds.push(spec.id);
    const result = await assessPhaseTransition(memexId, spec.id, "build");
    expect(result.facts.openDecisionsCount).toBe(0);
    expect(result.facts.incompleteTasksCount).toBe(0);
    expect(result.facts.unresolvedDriftCount).toBe(0);
    // spec-106 t-4: a bare Overview-only Spec is missing both core lenses, so
    // the build-target assessment now carries the missing-core-lens soft nudge
    // (dec-1). The only nudges present are those lens warnings — no
    // decision/task/drift nudges, which is what "clean facts" means here.
    expect(
      result.nudges.filter((n) => !/Missing core lens/i.test(n)),
    ).toEqual([]);
  });

  it("counts open decisions and emits a nudge for forward transitions", async () => {
    const spec = await createDocDraft(memexId, "Open decision", "Purpose", "spec");
    createdDocIds.push(spec.id);
    const dec = await createDecision(memexId, spec.id, "Decide DB?");

    const result = await assessPhaseTransition(memexId, spec.id, "build");
    expect(result.facts.openDecisionsCount).toBe(1);
    expect(result.facts.openDecisions[0]).toEqual({
      handle: `dec-${dec.seq}`,
      title: "Decide DB?",
    });
    expect(result.nudges.some((n) => /open decision/i.test(n))).toBe(true);
  });

  it("breaks down ready vs blocked tasks for verify target", async () => {
    const spec = await createDocDraft(memexId, "Tasks breakdown", "Purpose", "spec");
    createdDocIds.push(spec.id);
    // Move to build so tasks are allowed (createTask doesn't enforce phase though)
    await updateDocStatus(memexId, spec.id, "build");
    const t1 = await createTask(memexId, spec.id, "Task A", "Do A");
    const t2 = await createTask(memexId, spec.id, "Task B", "Do B");
    await updateTaskStatus(memexId, t2.id, "complete");

    const result = await assessPhaseTransition(memexId, spec.id, "verify");
    expect(result.facts.incompleteTasksCount).toBe(1);
    expect(result.facts.readyTasksCount).toBe(1);
    expect(result.facts.blockedTasksCount).toBe(0);
    expect(result.facts.incompleteTasks[0].handle).toBe(`t-${t1.seq}`);
    expect(result.nudges.some((n) => /incomplete task/i.test(n))).toBe(true);
  });

  it("counts unresolved drift comments on Spec entities", async () => {
    const spec = await createDocDraft(memexId, "Drift counts", "Purpose", "spec");
    createdDocIds.push(spec.id);
    await addComment(memexId, spec.sections[0].id, "agent", "drifty", { type: "drift", source: "agent" });
    const result = await assessPhaseTransition(memexId, spec.id, "verify");
    expect(result.facts.unresolvedDriftCount).toBe(1);
    expect(result.nudges.some((n) => /drift/i.test(n))).toBe(true);
  });

  it("flags resolved-decision narrative coverage by section reference", async () => {
    const spec = await createDocDraft(memexId, "Coverage", "Purpose", "spec");
    createdDocIds.push(spec.id);
    const dec = await createDecision(memexId, spec.id, "Pick stack");
    await resolveDecision(memexId, dec.id, "Picked Postgres");
    const handle = `dec-${dec.seq}`;
    // Update overview content to mention the handle so coverage check passes
    const { updateSection } = await import("./sections.js");
    await updateSection(memexId, spec.sections[0].id, `Decision recorded: ${handle}`);

    const result = await assessPhaseTransition(memexId, spec.id, "verify");
    const cov = result.facts.resolvedDecisionCoverage.find((c) => c.decisionHandle === handle);
    expect(cov).toBeDefined();
    expect(cov!.hasConsequenceSection).toBe(true);
  });

  it("stamps the recency cache so wasRecentlyAssessed returns true", async () => {
    const spec = await createDocDraft(memexId, "Recency", "Purpose", "spec");
    createdDocIds.push(spec.id);
    expect(wasRecentlyAssessed(spec.id, "build")).toBe(false);
    await assessPhaseTransition(memexId, spec.id, "build");
    expect(wasRecentlyAssessed(spec.id, "build")).toBe(true);
    // Different target phase is independent
    expect(wasRecentlyAssessed(spec.id, "verify")).toBe(false);
  });

  it("recency window expires past the cutoff", async () => {
    const spec = await createDocDraft(memexId, "Expiring", "Purpose", "spec");
    createdDocIds.push(spec.id);
    await assessPhaseTransition(memexId, spec.id, "verify");
    // 0ms window — strictly less-than → false
    expect(wasRecentlyAssessed(spec.id, "verify", 0)).toBe(false);
    // 1h window — should be true
    expect(wasRecentlyAssessed(spec.id, "verify", 60 * 60 * 1000)).toBe(true);
  });
});

// spec-106 t-4 — specify→build missing-core-lens soft nudge (dec-1). The
// assessment SURFACES a Spec missing a core lens (Design & UX, Architecture &
// Security) with a warning that NAMES the lens, but the verdict stays
// proceed-with-caveats — the transition is never blocked.
describe("specify→build missing-core-lens soft nudge (spec-106 t-4)", () => {
  it("detectMissingCoreLenses heuristic flags absent lenses and ignores present ones", () => {
    tagAc(`${SPEC}/acs/ac-7`);
    // Bare Overview-only Spec — both core lenses missing.
    expect(
      detectMissingCoreLenses([{ sectionType: "overview", title: "Overview" }]),
    ).toEqual(["Design & UX", "Architecture & Security"]);
    // Canonical spec-shaped section types satisfy both lenses.
    expect(
      detectMissingCoreLenses([
        { sectionType: "overview", title: "Overview" },
        { sectionType: "approach", title: "Approach" },
        { sectionType: "implementation-surface", title: "Implementation Surface" },
      ]),
    ).toEqual([]);
    // Human-label section types also satisfy (free-text, dec-2).
    expect(
      detectMissingCoreLenses([
        { sectionType: "design-ux", title: "Design & UX" },
        { sectionType: "architecture-security", title: "Architecture & Security" },
      ]),
    ).toEqual([]);
    // One present, one missing — names only the missing one.
    expect(
      detectMissingCoreLenses([
        { sectionType: "overview", title: "Overview" },
        { sectionType: "approach", title: "Approach" },
      ]),
    ).toEqual(["Architecture & Security"]);
  });

  it("ac-4/ac-7: surfaces a naming warning for a Spec missing Architecture & Security, verdict stays proceed-with-caveats (not hold)", async () => {
    tagAc(`${SPEC}/acs/ac-4`);
    tagAc(`${SPEC}/acs/ac-7`);
    // Spec with a Design & UX lens (approach) but NO Architecture & Security.
    const spec = await createDocDraft(memexId, "Missing arch lens", "Purpose", "spec");
    createdDocIds.push(spec.id);
    await addSection(memexId, spec.id, "approach", "How we design it", "Approach");

    const result = await assessPhaseTransition(memexId, spec.id, "build");

    // The warning is present and NAMES the missing lens in its lead line...
    const lensNudge = result.nudges.find((n) => /Missing core lens/i.test(n));
    expect(lensNudge).toBeDefined();
    expect(lensNudge).toMatch(/Missing core lens: Architecture & Security/);
    // ...and the substituted {lens} list does NOT include the present lens
    // (Design & UX appears only later in the std-18 reference sentence, not in
    // the "Missing core lens:" enumeration).
    expect(lensNudge).not.toMatch(/Missing core lens:[^.]*Design & UX/);

    // Verdict is proceed-with-caveats, NOT hold: the only hold-flavoured
    // signal at specify→build is the decisions-need-ACs gate
    // ("Specify→build is a hold until..."), which is absent here (no resolved
    // decisions). The missing-lens warning itself never claims a hold — it
    // explicitly says the transition is NOT blocked.
    expect(result.nudges.some((n) => /is a hold/i.test(n))).toBe(false);

    // The warning is visible in the rendered assessment (ac-4).
    const rendered = formatPhaseAssessment(result);
    expect(rendered).toMatch(/Missing core lens: Architecture & Security/);
  });

  it("ac-8: the warning does NOT prevent the specify→build transition from succeeding", async () => {
    tagAc(`${SPEC}/acs/ac-8`);
    const spec = await createDocDraft(memexId, "Lens warning non-blocking", "Purpose", "spec");
    createdDocIds.push(spec.id);
    await updateDocStatus(memexId, spec.id, "specify");

    // Assessment carries the missing-lens warning (both core lenses absent).
    const result = await assessPhaseTransition(memexId, spec.id, "build");
    expect(result.nudges.some((n) => /Missing core lens/i.test(n))).toBe(true);

    // ...yet update_doc({status:'build'}) still succeeds — soft nudge, no gate.
    const updated = await updateDocStatus(memexId, spec.id, "build");
    expect(updated.status).toBe("build");
  });
});

// spec-112 t-8 — verify→done SOFT warning for open/converted Issues. The warning
// rides BOTH the assess_spec fact sheet / nudges and the shared readiness view
// (ac-5), names the count (ac-17), is absent when every Issue is settled (ac-17),
// and never blocks update_doc({status:'done'}) (ac-18).
const SPEC_112 = "mindset-prod/memex-building-itself/specs/spec-112";
const AC112 = (n: number) => `${SPEC_112}/acs/ac-${n}`;

// Helper: a Spec moved all the way to `verify`, ready for the done gate.
async function specInVerify(title: string): Promise<string> {
  const spec = await createDocDraft(memexId, title, "Purpose", "spec");
  createdDocIds.push(spec.id);
  await updateDocStatus(memexId, spec.id, "specify");
  await updateDocStatus(memexId, spec.id, "build");
  await updateDocStatus(memexId, spec.id, "verify");
  return spec.id;
}

describe("verify→done open/converted Issue warning (spec-112 t-8)", () => {
  it("warns and names the count when open/converted Issues exist (ac-17)", async () => {
    tagAc(AC112(17));
    const docId = await specInVerify("Done with open issues");

    // One open Issue, plus one converted Issue (open → converted via down-bridge).
    await createIssue({ memexId, docId, title: "Bug still live", body: "b", type: "bug" });
    const toConvert = await createIssue({
      memexId,
      docId,
      title: "Todo to deliver",
      body: "b",
      type: "todo",
    });
    await convertIssueToTask(memexId, toConvert.id); // → converted

    const result = await assessPhaseTransition(memexId, docId, "done");

    // Fact carries the in-flight count (open + converted = 2).
    expect(result.facts.openIssuesCount).toBe(2);

    // A nudge fires that NAMES the count.
    const issueNudge = result.nudges.find((n) => /open or converted Issue/i.test(n));
    expect(issueNudge).toBeDefined();
    expect(issueNudge).toMatch(/2 open or converted Issues/);

    // It's visible in the rendered assessment too.
    const rendered = formatPhaseAssessment(result);
    expect(rendered).toMatch(/Open\/converted Issues: 2/);
  });

  it("emits NO issue warning when every Issue is resolved/wont_fix or none exist (ac-17)", async () => {
    tagAc(AC112(17));

    // (a) No Issues at all.
    const emptyDoc = await specInVerify("Done with no issues");
    const emptyResult = await assessPhaseTransition(memexId, emptyDoc, "done");
    expect(emptyResult.facts.openIssuesCount).toBe(0);
    expect(emptyResult.nudges.some((n) => /open or converted Issue/i.test(n))).toBe(false);
    expect(
      emptyResult.readiness.outstandingItems.some((i) => i.kind === "open_issues"),
    ).toBe(false);

    // (b) Issues exist but all settled — one resolved, one wont_fix.
    const settledDoc = await specInVerify("Done with settled issues");
    const a = await createIssue({
      memexId,
      docId: settledDoc,
      title: "Fixed bug",
      body: "b",
      type: "bug",
    });
    const b = await createIssue({
      memexId,
      docId: settledDoc,
      title: "Abandoned todo",
      body: "b",
      type: "todo",
    });
    await updateIssueStatus(memexId, a.id, "resolved");
    await updateIssueStatus(memexId, b.id, "wont_fix");

    const settledResult = await assessPhaseTransition(memexId, settledDoc, "done");
    expect(settledResult.facts.openIssuesCount).toBe(0);
    expect(settledResult.nudges.some((n) => /open or converted Issue/i.test(n))).toBe(false);
    expect(
      settledResult.readiness.outstandingItems.some((i) => i.kind === "open_issues"),
    ).toBe(false);
  });

  it("the warning carries on BOTH surfaces — phase-assessment nudge AND shared readiness (ac-5)", async () => {
    tagAc(AC112(5));
    const docId = await specInVerify("Done with issue on both surfaces");
    await createIssue({ memexId, docId, title: "Open bug", body: "b", type: "bug" });

    const result = await assessPhaseTransition(memexId, docId, "done");

    // Surface 1 — phase-assessment nudge + fact.
    expect(result.facts.openIssuesCount).toBe(1);
    expect(result.nudges.some((n) => /1 open or converted Issue/i.test(n))).toBe(true);

    // Surface 2 — the shared readiness computation the React UI consumes.
    const item = result.readiness.outstandingItems.find((i) => i.kind === "open_issues");
    expect(item).toMatchObject({
      kind: "open_issues",
      count: 1,
      label: "1 open or converted Issue",
    });
  });

  it("is NON-BLOCKING — update_doc({status:'done'}) still succeeds with open Issues (ac-18)", async () => {
    tagAc(AC112(18));
    const docId = await specInVerify("Done despite open issue");
    await createIssue({ memexId, docId, title: "Lingering bug", body: "b", type: "bug" });

    // The assessment warns...
    const result = await assessPhaseTransition(memexId, docId, "done");
    expect(result.nudges.some((n) => /open or converted Issue/i.test(n))).toBe(true);

    // ...yet the transition to done still goes through — soft nudge, never a gate.
    const updated = await updateDocStatus(memexId, docId, "done");
    expect(updated.status).toBe("done");
  });
});
