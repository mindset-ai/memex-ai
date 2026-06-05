import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  documents,
  decisions,
  tasks,
  docComments,
  docSections,
  memexes,
  namespaces,
} from "../db/schema.js";
import { createDocDraft, updateDocStatus } from "../services/documents.js";
import { addSection } from "../services/sections.js";
import { addComment } from "../services/comments.js";
import { createDecision } from "../services/decisions.js";
import { executeServerTool } from "./tools.js";
import {
  assessPhaseTransition,
  _clearRecentAssessments,
} from "../services/phase-assessment.js";
import { makeTestMemex } from "../services/test-helpers.js";

// Doc-12 t-7 — soft "no recent readiness review" nudge on the agent's
// update_doc_status tool. Tests cover the recent-vs-not-recent paths for the
// three forward Spec transitions, plus the no-nudge cases (backward
// transitions, non-forward transitions, non-Missions).

const createdDocIds: string[] = [];
let memexId: string;
let slugs: { namespace: string; memex: string };
const userId = "00000000-0000-0000-0000-000000000099";

// b-36 T-6: every entity-acting tool takes a canonical ref. Build them from
// the test memex's slug pair + the doc's handle. docType decides the URL
// segment: spec → /specs/, document → /docs/.
function refFor(doc: { docType: string; handle: string }): string {
  const docTypeUrl =
    doc.docType === "spec"
      ? "specs"
      : doc.docType === "standard"
        ? "standards"
        : doc.docType === "execution_plan"
          ? "execution-plans"
          : "docs";
  return `${slugs.namespace}/${slugs.memex}/${docTypeUrl}/${doc.handle}`;
}

beforeAll(async () => {
  memexId = await makeTestMemex();
  const memex = await db.query.memexes.findFirst({ where: eq(memexes.id, memexId) });
  const ns = await db.query.namespaces.findFirst({
    where: eq(namespaces.id, memex!.namespaceId),
  });
  slugs = { namespace: ns!.slug, memex: memex!.slug };
});

afterAll(async () => {
  for (const id of createdDocIds) {
    // Comments hang off sections/decisions/tasks — clear them first to avoid
    // FK violations.
    const sectionRows = await db.select().from(docSections).where(eq(docSections.docId, id));
    for (const s of sectionRows) {
      await db.delete(docComments).where(eq(docComments.sectionId, s.id)).catch(() => {});
    }
    const decisionRows = await db.select().from(decisions).where(eq(decisions.docId, id));
    for (const d of decisionRows) {
      await db.delete(docComments).where(eq(docComments.decisionId, d.id)).catch(() => {});
    }
    const taskRows = await db.select().from(tasks).where(eq(tasks.docId, id));
    for (const t of taskRows) {
      await db.delete(docComments).where(eq(docComments.taskId, t.id)).catch(() => {});
    }
    await db.delete(docSections).where(eq(docSections.docId, id)).catch(() => {});
    await db.delete(tasks).where(eq(tasks.docId, id)).catch(() => {});
    await db.delete(decisions).where(eq(decisions.docId, id)).catch(() => {});
    await db.delete(documents).where(eq(documents.id, id)).catch(() => {});
  }
});

beforeEach(() => {
  _clearRecentAssessments();
});

async function makeMissionInPhase(phase: string): Promise<{ id: string; handle: string; docType: string }> {
  const m = await createDocDraft(memexId, `Spec for ${phase}`, "Purpose", "spec");
  createdDocIds.push(m.id);
  if (phase !== "draft") {
    // Walk through phases respecting the existing service-layer rules.
    const stages = ["plan", "build", "verify", "done"];
    for (const s of stages) {
      await updateDocStatus(memexId, m.id, s);
      if (s === phase) break;
    }
  }
  return { id: m.id, handle: m.handle, docType: m.docType };
}

describe("update_doc_status nudge (t-7)", () => {
  it("nudges plan→build when no recent readiness review", async () => {
    const m = await makeMissionInPhase("plan");
    const result = await executeServerTool(
      memexId,
      "update_doc",
      { ref: refFor(m), status: "build" },
      userId,
    );
    expect(result).toMatch(/run assess_spec/i);
  });

  it("nudges build→verify when no recent readiness review", async () => {
    const m = await makeMissionInPhase("build");
    const result = await executeServerTool(
      memexId,
      "update_doc",
      { ref: refFor(m), status: "verify" },
      userId,
    );
    expect(result).toMatch(/run assess_spec/i);
  });

  it("verify→done succeeds and emits the dec-3 verbatim warning when no recent assess (doc-12 t-6)", async () => {
    // Per doc-12 dec-6, the verify→done hard block is lifted at the service
    // layer — the agent surface now emits the dec-3 verbatim warning instead
    // of refusing the call. Closing a Spec stays the user's call, but the
    // agent isn't blocked from doing it after a successful readiness review.
    const m = await makeMissionInPhase("verify");
    const result = await executeServerTool(
      memexId,
      "update_doc",
      { ref: refFor(m), status: "done" },
      userId,
    );
    expect(result).toMatch(/Strongly recommend confirming with the user/i);
    expect(result).toMatch(/verify→done readiness review/i);
  });

  it("verify→done emits NO warning when assess was recent", async () => {
    const m = await makeMissionInPhase("verify");
    await assessPhaseTransition(memexId, m.id, "done");
    const result = await executeServerTool(
      memexId,
      "update_doc",
      { ref: refFor(m), status: "done" },
      userId,
    );
    expect(result).not.toMatch(/Strongly recommend/i);
    expect(result).not.toMatch(/⚠/);
  });

  it("does NOT nudge when assess_phase_transition was called recently", async () => {
    const m = await makeMissionInPhase("plan");
    await assessPhaseTransition(memexId, m.id, "build");
    const result = await executeServerTool(
      memexId,
      "update_doc",
      { ref: refFor(m), status: "build" },
      userId,
    );
    expect(result).not.toMatch(/run assess_spec/i);
    expect(result).not.toMatch(/⚠/);
  });

  it("does NOT nudge on backward transitions (build→plan)", async () => {
    const m = await makeMissionInPhase("build");
    const result = await executeServerTool(
      memexId,
      "update_doc",
      { ref: refFor(m), status: "plan" },
      userId,
    );
    expect(result).not.toMatch(/run assess_spec/i);
    expect(result).not.toMatch(/⚠/);
  });

  it("does NOT nudge on draft→plan (no rubric)", async () => {
    const m = await makeMissionInPhase("draft");
    const result = await executeServerTool(
      memexId,
      "update_doc",
      { ref: refFor(m), status: "plan" },
      userId,
    );
    expect(result).not.toMatch(/run assess_spec/i);
    expect(result).not.toMatch(/⚠/);
  });

  it("does NOT nudge on no-op (same status)", async () => {
    const m = await makeMissionInPhase("build");
    const result = await executeServerTool(
      memexId,
      "update_doc",
      { ref: refFor(m), status: "build" },
      userId,
    );
    expect(result).not.toMatch(/run assess_spec/i);
    expect(result).not.toMatch(/⚠/);
  });

  it("does NOT nudge on non-Spec docTypes", async () => {
    // Use canonical 'document' docType so the ref resolves through /docs/
    // (legacy 'spec' rows pre-date the b-36 ref grammar; resolver maps DocType
    // 'docs' → DB docType 'document').
    const doc = await createDocDraft(memexId, "Spec", "Purpose", "document");
    createdDocIds.push(doc.id);
    const result = await executeServerTool(
      memexId,
      "update_doc",
      { ref: refFor(doc), status: "review" },
      userId,
    );
    expect(result).not.toMatch(/run assess_spec/i);
  });

  // ── DRY refactor: structured blockers from @memex/shared ──
  it("includes the structured 'Outstanding work' list when there are open comments", async () => {
    const m = await makeMissionInPhase("plan");
    const section = await addSection(memexId, m.id, "purpose", "Body", "Purpose");
    await addComment(memexId, section.id, "tester", "open question", { type: "discussion" });
    const result = await executeServerTool(
      memexId,
      "update_doc",
      { ref: refFor(m), status: "build" },
      userId,
    );
    expect(result).toMatch(/Outstanding work:/);
    expect(result).toMatch(/1 open comment/);
    expect(result).toMatch(/"Resolve Comments"/);
  });

  it("includes the 'Outstanding work' list when the narrative is stale (decisions newer than consolidation)", async () => {
    const m = await makeMissionInPhase("plan");
    // Spec has never been consolidated → every decision counts as stale.
    await createDecision(memexId, m.id, "Pick a database");
    const result = await executeServerTool(
      memexId,
      "update_doc",
      { ref: refFor(m), status: "build" },
      userId,
    );
    expect(result).toMatch(/Outstanding work:/);
    expect(result).toMatch(/not yet reflected in the narrative/);
    expect(result).toMatch(/"New decisions — update narrative"/);
  });

  it("omits the 'Outstanding work' list when the Spec is clean", async () => {
    const m = await makeMissionInPhase("plan");
    const result = await executeServerTool(
      memexId,
      "update_doc",
      { ref: refFor(m), status: "build" },
      userId,
    );
    // Header still fires (no recent assess) but no Outstanding section.
    expect(result).toMatch(/run assess_spec/i);
    expect(result).not.toMatch(/Outstanding work:/);
  });
});
