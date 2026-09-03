// spec-464 dec-2 / dec-24: the PHASE GATE.
//
// Sits at the single tool-dispatch seam (services/spec-traffic.ts
// runToolWithSpecTraffic), BEFORE the handler writes, alongside
// enforceCheckoutGate. An ahead-of-phase agent tool call — the tool's
// `homePhase` strictly later than the Spec's current phase — is REFUSED with a
// teaching message drawn from the scaffold catalog; the handler never runs, no
// write, no phase move. Behind-phase and in-phase calls run normally.
//
// Channel posture (dec-2 / dec-23):
//   - `mcp` and `in_app_agent` are gated IDENTICALLY.
//   - `rest_ui` (the human web UI) is NEVER phase-gated — the always-open
//     escape valve. (It doesn't route through this seam today; the guard is
//     belt-and-suspenders so the invariant holds if that ever changes.)
//
// Outcomes:
//   throw ValidationError  → hard refusal (ahead-of-phase) or done-reopen. The
//                            message is surfaced to the agent verbatim.
//   return string          → an advisory / nudge to append to the response
//                            (draft planning nudge dec-3/5; behind advisory dec-21).
//   return null            → allowed, no note (in-phase, ungated, rest_ui, done+cross-cutting).
//
// The teaching PROSE lives in the scaffold catalog (PHASE_GATING_CATALOG,
// scaffold-data.ts) per std-15/dec-24 — this module holds only the gate LOGIC,
// so a change to a tool's home phase (manifest) or a refusal string (scaffold)
// takes effect with no edit here (ac-24). This generalizes the spec-327
// createTask guard from one tool to the manifest-driven set.

import { ValidationError } from "../types/errors.js";
import {
  isForwardTransition,
  toolManifest,
  PHASE_GATING_CATALOG,
  type ToolManifestEntry,
  type PhaseGateGroup,
} from "@memex/shared";
import { isSpecStatus } from "../types/roles.js";
import type { ToolCtx } from "../agent/handlers/tool-contract.js";

const manifestByName: ReadonlyMap<string, ToolManifestEntry> = new Map(
  toolManifest.map((e) => [e.name, e]),
);

// dec-18: narrative section tools are NEVER ahead-gated (they run in every
// working phase), but the done-reopen rule (dec-22) DOES apply to them — so
// they count as spec primitives for the done check even though homePhase=null.
const NARRATIVE_SECTION_TOOLS = new Set<string>([
  "add_section",
  "update_section",
  "retitle_section",
  "delete_section",
]);

// The task/bridge tools (home 'build'). convert_issue_to_task / kick_task_to_issue
// mint or destroy a TASK, so they follow the task rules, not the issue rules (dec-19).
const TASK_TOOLS = new Set<string>([
  "create_task",
  "update_task",
  "delete_task",
  "convert_issue_to_task",
  "kick_task_to_issue",
]);

/** The message group for a mutating tool, used to select the refusal string.
 *  `planning` (decisions + scope AND implementation ACs) is never hard-refused —
 *  a draft gets the nudge; `task` / `qa_report` are refused ahead of build.
 *
 *  spec-464 dec-10/11 (revised): implementation ACs are authored in `specify`
 *  like decisions and scope ACs — the platform's specify→build readiness gate
 *  REQUIRES an implementation AC per resolved decision BEFORE the build move
 *  (assess_spec rubric + spec-391 + the create_ac coverage footer), so refusing
 *  them ahead of build would make that gate unsatisfiable. So `create_ac` is a
 *  planning tool for both kinds; only tasks and the QA report are build-home. */
function groupOf(toolName: string): PhaseGateGroup {
  if (TASK_TOOLS.has(toolName)) return "task";
  if (toolName === "write_qa_report") return "qa_report";
  return "planning";
}

/**
 * Enforce the phase gate for an agent tool call, BEFORE its handler writes.
 * Returns a note to append to the response (nudge / advisory) or null; throws a
 * ValidationError (surfaced verbatim) on an ahead-of-phase refusal or a
 * done-Spec reopen-first redirect. A no-op for read-only / unknown tools, the
 * rest_ui channel, unresolvable refs, and non-spec docs.
 */
export async function enforcePhaseGate(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ToolCtx,
): Promise<string | null> {
  const entry = manifestByName.get(toolName);
  if (!entry || entry.readOnlyHint) return null;
  // dec-2/dec-23: only the agent channels (mcp / in_app_agent) route through
  // this seam, and they are gated IDENTICALLY. The human web UI (rest_ui) drives
  // its mutations through the REST handlers, not this seam, so it is
  // structurally exempt — the always-open escape valve (ctx.channel is typed
  // 'mcp' | 'in_app_agent' | undefined here, never 'rest_ui').

  // Most gated tools take `ref`; link_ac_to_decision takes `ac_ref`/`decision_ref`
  // (no `ref`). Resolve whichever ref-shaped arg is present so that tool isn't
  // silently skipped — both of its refs point into the same Spec, so either
  // yields the right doc + phase.
  const ref = [input.ref, input.ac_ref, input.decision_ref].find(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  if (ref === undefined) return null;
  let resolved;
  try {
    resolved = await ctx.resolveRef(ref);
  } catch {
    return null; // unresolvable → let the handler raise its own clean error
  }
  if (resolved.doc.docType !== "spec") return null; // only Specs have a lifecycle
  const current = resolved.doc.status;
  if (!isSpecStatus(current)) return null;

  const home = entry.homePhase;
  const isSpecPrimitive = home !== null || NARRATIVE_SECTION_TOOLS.has(toolName);

  // dec-22: a done Spec is a deliberate closed placement (spec-464 dec-1 removed
  // the old auto-reopen). Spec-primitive mutations are refused reopen-first;
  // issues + cross-cutting tools (home null, not a section tool) still run.
  if (current === "done") {
    if (isSpecPrimitive) throw new ValidationError(PHASE_GATING_CATALOG.doneReopen);
    return null;
  }

  if (home === null) return null; // never ahead-gated
  if (home === current) return null; // in-phase

  if (isForwardTransition(current, home)) {
    // AHEAD of home. Planning tools (decisions + scope AND implementation ACs,
    // home 'specify') are allowed one step early in draft with a publish nudge
    // (dec-3/5); draft and specify share the planning toolset. Only tasks and the
    // QA report (home 'build') hard-refuse ahead.
    const group = groupOf(toolName);
    if (group === "planning") return PHASE_GATING_CATALOG.draftPlanningNudge;
    const message =
      PHASE_GATING_CATALOG.refusals[`${group}:${current}`] ??
      PHASE_GATING_CATALOG.refusals[`${group}:specify`];
    throw new ValidationError(message);
  }

  // BEHIND home (home earlier than current) → allowed, never a refusal, no phase
  // change. The QA report is in-phase from build onward (dec-16/17) and create_ac
  // is legitimately used in build/verify (authoring impl ACs alongside tasks, or
  // late scope tweaks), so neither gets a note. Tasks and the decision tools may
  // get a soft advisory when revisited late (dec-21).
  const group = groupOf(toolName);
  if (group === "qa_report" || toolName === "create_ac") return null;
  return PHASE_GATING_CATALOG.behindAdvisory[current] ?? null;
}
