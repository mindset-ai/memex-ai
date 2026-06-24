// spec-340 t-7 — the facet gate at the verify/done transitions (dec-4).
//
// Mirrors the code-grounding self-classification in phase-assessment.ts: a
// structured, durable parameter (facetAck) the agent supplies, surfaced as a
// PROMPT when absent and echoed as a nudge when supplied — never prose-only. The
// gate is NON-BLOCKING (dec-1): it produces nudges that ride the readiness rubric
// (like the naked-decision hold), it never throws a block on update_doc, and it
// gates nothing in the developer's editing/commit/push path.
//
// Two halves:
//   • predictive (build side): tasks with no ballot are surfaced — advisory.
//   • confirmatory (verify/done, LOAD-BEARING): the spec's routed standards are
//     handed back and must be acknowledged (facetAck:true) against the diff
//     before the spec should reach done.

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { tasks, taskFacetBallots } from "../db/schema.js";
import { routeStandardsForSpec, type GoverningStandard } from "./facet-routing.js";

export interface FacetGateResult {
  /** Standards the spec's facet union routes to (the confrontation set). */
  standards: GoverningStandard[];
  /** Incomplete tasks on the spec with no facet ballot (predictive-pass gap). */
  tasksMissingBallot: number;
  /** True when standards were surfaced but the agent has not acknowledged them. */
  ackPending: boolean;
}

async function countTasksMissingBallot(memexId: string, specDocId: string): Promise<number> {
  const taskRows = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.docId, specDocId), eq(tasks.memexId, memexId)));
  if (taskRows.length === 0) return 0;
  const ids = taskRows.map((t) => t.id);
  const balloted = await db
    .select({ taskId: taskFacetBallots.taskId })
    .from(taskFacetBallots)
    .where(and(eq(taskFacetBallots.memexId, memexId), inArray(taskFacetBallots.taskId, ids)));
  const ballotedSet = new Set(balloted.map((b) => b.taskId));
  return ids.filter((id) => !ballotedSet.has(id)).length;
}

export async function evaluateFacetGate(
  memexId: string,
  specDocId: string,
  facetAck?: boolean,
): Promise<FacetGateResult> {
  const standards = await routeStandardsForSpec(memexId, specDocId);
  const tasksMissingBallot = await countTasksMissingBallot(memexId, specDocId);
  return { standards, tasksMissingBallot, ackPending: standards.length > 0 && facetAck !== true };
}

/**
 * The nudges the facet gate contributes to the readiness assessment. Pure (no
 * DB) so the formatter stays testable. Advisory throughout — every line names a
 * hold the agent SHOULD clear, never a block update_doc will enforce.
 */
export function facetGateNudges(
  gate: FacetGateResult,
  targetPhase: "verify" | "done",
  facetAck?: boolean,
): string[] {
  const out: string[] = [];

  if (gate.tasksMissingBallot > 0) {
    out.push(
      `${gate.tasksMissingBallot} incomplete task${gate.tasksMissingBallot === 1 ? " has" : "s have"} no facet ballot. ` +
        `The predictive ballot is advisory (it never blocks), but an unballoted task routed no standards — ` +
        `cast it via create_task's \`facetBallot\` so its facets surface their governing standards.`,
    );
  }

  if (gate.standards.length > 0) {
    const list = gate.standards.map((s) => `${s.handle} [${s.facetKeys.join(", ")}]`).join("; ");
    if (facetAck === true) {
      out.push(`Facet gate: standards acknowledged against the diff — ${list}.`);
    } else {
      out.push(
        `Facet gate (load-bearing at ${targetPhase}): this spec's work touches facets governed by ` +
          `${gate.standards.length} standard${gate.standards.length === 1 ? "" : "s"}: ${list}. ` +
          `Re-check each against the ACTUAL diff, then re-call assess_spec with \`facetAck: true\` to acknowledge ` +
          `before advancing to done. (Advisory hold — update_doc still succeeds; nothing gates your editing or commits.)`,
      );
    }
  }

  return out;
}
