// sol-5 (spec-368, std-12): `formatPhaseAssessment` is PRESENTATION — it turns a
// `PhaseAssessment` fact sheet into the agent-readable markdown string. It used
// to live in `services/phase-assessment.ts` next to the assessment logic; per
// sol-5 it now lives here in the neutral `formatting/` home alongside the other
// formatters. `services/phase-assessment.ts` re-exports it so existing importers
// (agent/handlers/lifecycle.ts, the phase-assessment test suites) keep working
// unchanged. The output is byte-identical to the prior co-located version.
import {
  isForwardTransition,
  blockerLines,
  timeAgo,
  capitalizeDisplayName,
  type SpecPhase,
} from "@memex/shared";
import type { PhaseAssessment } from "../services/phase-assessment.js";
import { CODE_GROUNDING_PROMPT } from "../services/phase-assessment.js";

/**
 * Format a phase assessment as a single agent-readable string.
 *
 * Designed for the agent's tool result — keep the rubric verbatim (the agent is
 * walking it against the facts) and the fact sheet compact and grep-able.
 */
export function formatPhaseAssessment(assessment: PhaseAssessment): string {
  const lines: string[] = [];
  lines.push(`# Readiness assessment: ${assessment.transition}`);
  lines.push(
    `Spec ${assessment.specHandle} "${assessment.specTitle}" (current phase: ${assessment.currentPhase})`,
  );
  lines.push("");

  // Fact sheet first — grep-able for the agent.
  lines.push("## Spec facts");
  const f = assessment.facts;
  lines.push(`- Open decisions: ${f.openDecisionsCount}`);
  if (f.openDecisions.length > 0) {
    for (const d of f.openDecisions) {
      lines.push(`  - ${d.handle} "${d.title}"`);
    }
  }
  lines.push(
    `- Incomplete tasks: ${f.incompleteTasksCount} (${f.readyTasksCount} ready, ${f.blockedTasksCount} blocked)`,
  );
  if (f.incompleteTasks.length > 0) {
    for (const t of f.incompleteTasks) {
      lines.push(
        `  - ${t.handle} "${t.title}" — status=${t.status}${t.blocked ? ", blocked" : ""}`,
      );
    }
  }
  lines.push(`- Unresolved drift comments: ${f.unresolvedDriftCount}`);
  lines.push(`- Unresolved plan_revision comments: ${f.unresolvedPlanRevisionCount}`);
  // spec-120 ac-3: open comments broken down by type so hold-signals
  // (review / question / drift / plan_revision) are distinguishable from
  // provenance notes (progress / plan) without a separate list_comments call.
  lines.push(`- Open comments: ${f.openCommentsCount}`);
  if (f.openCommentsCount > 0) {
    const byType = Object.entries(f.openCommentsByType).sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
    for (const [type, count] of byType) {
      lines.push(`  - ${type}: ${count}`);
    }
  }
  // spec-259 t-3: on the specify→build gate, enrich the open-comment block —
  // grouped by anchor kind (decision-anchored vs section-anchored), oldest age
  // per group via timeAgo, and a per-comment WHO/WHEN list (author + age +
  // anchor handle/title + snippet). Rendered ONLY when `openCommentsDetail` is
  // present (build target) and there are open comments; other targets keep the
  // counts-only view above (ac-1).
  if (assessment.openCommentsDetail && assessment.openCommentsDetail.totalOpen > 0) {
    const groups = assessment.openCommentsDetail.byAnchorKind;
    const renderGroup = (label: string, g: typeof groups.decision): void => {
      if (g.count === 0) return;
      const age = g.oldestCreatedAt ? timeAgo(g.oldestCreatedAt) : "unknown age";
      lines.push(`  - ${label}: ${g.count} (oldest ${age})`);
      for (const c of g.comments) {
        const targetTitle = c.target.title ? ` "${c.target.title}"` : "";
        lines.push(
          `    - ${capitalizeDisplayName(c.author)} ${timeAgo(c.createdAt)} on ${c.target.kind} ${c.target.handle}${targetTitle} [${c.type}]: ${c.contentSnippet}`,
        );
      }
    };
    renderGroup("Decision-anchored", groups.decision);
    renderGroup("Section-anchored", groups.section);
  }
  lines.push(`- Open/converted Issues: ${f.openIssuesCount}`);
  // spec-120 ac-1: AC verification state, from the same test_events derivation
  // list_acs uses — the gate and list_acs can never silently disagree. Failing
  // / stale handles are named inline so a verifier never needs a second call.
  const acv = f.acVerification;
  lines.push(
    `- AC verification: ${acv.totalActive} active — ${acv.verified} verified, ${acv.failing} failing, ${acv.stale} stale, ${acv.untested} untested${acv.accepted > 0 ? `, ${acv.accepted} accepted` : ""}`,
  );
  if (acv.failingHandles.length > 0) {
    lines.push(`  - FAILING: ${acv.failingHandles.join(", ")}`);
  }
  if (acv.staleHandles.length > 0) {
    lines.push(`  - STALE: ${acv.staleHandles.join(", ")}`);
  }
  lines.push(`- Sections: ${f.sections.length}`);
  if (f.resolvedDecisionCoverage.length > 0) {
    lines.push("- Resolved-decision narrative coverage (best-effort):");
    for (const c of f.resolvedDecisionCoverage) {
      lines.push(
        `  - ${c.decisionHandle} "${c.decisionTitle}" — narrative ${c.hasConsequenceSection ? "looks updated" : "may not capture consequence"}`,
      );
    }
  }
  if (f.resolvedDecisionAcCoverage.length > 0) {
    const nakedCount = f.resolvedDecisionAcCoverage.filter(
      (c) => c.implementationAcCount === 0,
    ).length;
    lines.push(
      `- Resolved-decision implementation-AC coverage: ${f.resolvedDecisionAcCoverage.length - nakedCount}/${f.resolvedDecisionAcCoverage.length} have ≥1 active implementation AC${nakedCount > 0 ? ` (${nakedCount} naked)` : ""}`,
    );
    for (const c of f.resolvedDecisionAcCoverage) {
      const label =
        c.implementationAcCount === 0
          ? "NAKED — no implementation AC"
          : `${c.implementationAcCount} implementation AC${c.implementationAcCount === 1 ? "" : "s"}`;
      lines.push(`  - ${c.decisionHandle} "${c.decisionTitle}" — ${label}`);
    }
  }
  lines.push("");

  // Code grounding (doc-27) — only rendered on the specify→build transition
  // when the agent hasn't yet supplied a `codeGrounding` value. Once the
  // agent answers, the classification is surfaced via the `## Nudges`
  // section below instead.
  if (assessment.codeGroundingPromptPending) {
    lines.push("## Code grounding");
    lines.push(CODE_GROUNDING_PROMPT);
    lines.push("");
  }

  // Outstanding work — same shared computation the React UI uses to gate the
  // PhaseDropdown. Only meaningful for forward transitions (the readiness rubric
  // exists for specify→build / build→verify / verify→done).
  const isForward = isForwardTransition(
    assessment.currentPhase as SpecPhase,
    assessment.targetPhase as SpecPhase,
  );
  if (isForward) {
    const lines2 = blockerLines(assessment.readiness);
    if (lines2.length > 0) {
      lines.push("## Outstanding work");
      for (const l of lines2) {
        lines.push(`- ${l}`);
      }
      lines.push("");
    }
  }

  if (assessment.nudges.length > 0) {
    lines.push("## Nudges");
    for (const n of assessment.nudges) {
      lines.push(`- ${n}`);
    }
    lines.push("");
  }

  // b-68 t-5 / t-7: composed rubric prose. Sits between the deterministic
  // sections above (facts, outstanding work, nudges) and the rubric-less
  // draft→specify note below. The `---` separator + dedicated heading make
  // the deterministic-data vs prose-rubric boundary unambiguous for the
  // agent and for downstream readers (ac-35). Emitted only when `toRubric`
  // returned non-empty content — keeps the section silent for transitions
  // that have neither base rubric nor Org additions (draft→specify today).
  if (assessment.rubricProse.length > 0) {
    lines.push("---");
    lines.push("## Rubric prose");
    lines.push(assessment.rubricProse.trim());
    lines.push("");
  }

  // Friendly note for the rubric-less draft→specify transition.
  if (assessment.rubricProse.length === 0 && assessment.rubricNote) {
    lines.push("## Rubric");
    lines.push(assessment.rubricNote);
  }

  return lines.join("\n");
}
