// spec-546: The guidance envelope: one public entry point, composeGuidanceEnvelope, which is
// the SOLE author of footer prose. Everything else here is its machinery.
//
// guidance-authoring-confined.regression.test.ts pins that invariant by scanning
// this directory as one text blob: renderFooterSignal must PRECEDE
// composeGuidanceEnvelope, and the prose builders may only be referenced between
// them. Do not reorder those two, and never move a prose builder out of
// agent/handlers/ — the guard would then pass while asserting nothing.
//
// Split out of agent/handlers/shared.ts (renamed tool-contract.ts in t-3)
// [per std-51: a module is named for its contents, never for the act that made it].

import { eq, } from "drizzle-orm";
import { db } from "../../db/connection.js";
import { documents } from "../../db/schema.js";
import {
  formatReplacesLead,
  formatSupersessionLead,
  listPredecessors,
} from "../../services/supersession.js";
import {
  listAcsForBriefWithVerification,
  type AcWithVerification,
} from "../../services/acs.js";
import { listActivityView } from "../../services/activity-view.js";
import { resolveTestEventActors } from "../../services/who-resolver.js";
import { stripUuids, containsUuid } from "../../services/shared/identifiers.js";
import { listPresent } from "../../services/presence.js";
import {
  formatSpecGuidanceBody,
} from "../../formatting/formatters.js";
import { buildSketchBlock } from "../../mcp/ac-test-sketch.js";
import {
  BASE_SCAFFOLD,
  HANDOFF_BUTTON_BY_PHASE,
  toButtonPrompt,
  toHandoffEssence,
  GET_PROMPT_PROSE,
  type Phase,
} from "@memex/shared";
import { claimFullHandoffDelivery } from "../../services/handoff-delivery.js";
import type { ToolCtx, FooterSignal } from "./tool-contract.js";
import { fullDocState, type FullDocState } from "./doc-state.js";
import { relatedIssuesNudge } from "./related-issues.js";

export const COMPLETION_NUDGE =
  "Leave a `progress` comment for whoever picks this up next: what landed, the contract it honours, any surprises, and what is left for downstream.";

/**
 * THE single seat that composes the platform guidance ENVELOPE — header + footer
 * (spec-203 ac-15 / ac-16; spec-219 ac-6).
 *
 * A tool call — any tool call — is the client phoning home; we return the real
 * tool result, then take that one opening to STEER the client.
 * `composeGuidanceEnvelope` is invoked at the single choke point
 * (`runToolWithSpecTraffic`) on EVERY Spec-resolving call (ac-14), and is the
 * only place a header or footer is composed (`formatFullDocState` composes
 * neither). It returns `{ header?, footer? }` where BOTH are DELIMITER-LESS
 * content: the choke point owns the single `FOOTER_DELIMITER` and writes it
 * exactly once when it assembles `header + body + FOOTER_DELIMITER + footer`
 * (spec-219 ac-7); the telemetry wrap then splits + persists the footer (ac-17).
 * An empty envelope `{}` means "nothing to add this time".
 *
 * Starting policy (deterministic; the SITUATIONAL logic — onboarding a first
 * Spec, a reprimand when an agent is drifting — evolves HERE, behind this one
 * function, with no caller change):
 *   - verbose reads → the FULL phase footer (toNudge prose + Org overlays +
 *     once-per-session full handoff + dynamic state) — today's content,
 *     preserved, including spec-193's tripwire vocabulary.
 *   - terse calls (the build loop) → the COMPACT footer (handoff essence +
 *     dynamic state incl. the AC nag), steering without flooding the agent.
 * One composer for both (`formatSpecGuidanceBody`).
 *
 * Best-effort: never throws — a guidance-policy failure must not cost the tool
 * its result.
 */
interface GuidanceEnvelope {
  header?: string;
  footer?: string;
}

/**
 * spec-219 dec-5 (t-4): the per-tool STEERING registry — the ONE place the
 * transition map (tool T → the move we want next, T+1) lives. Keyed by the
 * dispatching tool, it is the seam that makes the footer TRANSITION-keyed rather
 * than purely phase-keyed (ac-11): two tools resolving the same Spec in the same
 * phase can get different footers.
 *
 * Division of labour (dec-5): handlers own RESULT-REPORTING (the footer slot,
 * t-3 — what the tool just did); the seat owns STEERING (this registry + the
 * phase guidance — where to go next). A steer here MUST COMPLEMENT, never echo,
 * the handler's slot nugget (ac-12) — so a tool that already parks a slot steer
 * (update_task's completion nudge, update_doc / publish_spec transition nudges)
 * deliberately has NO entry here. Phase 2 migrates the remaining scattered
 * per-tool steers (create_doc's scope-AC push, resolve_decision's impl-AC push,
 * …) into this one map; this is the seam they land on.
 */
const STEER_BY_TOOL: Partial<Record<string, (phase: Phase) => string | undefined>> = {
  // After editing a section while shaping the plan, the surgical next move is to
  // keep the narrative honest against the decisions. No other surface says this
  // per-tool, and update_section parks no slot nugget — so no echo.
  update_section: (phase) =>
    phase === "specify" || phase === "draft"
      ? "Steer: if this edit captures a resolved decision, confirm the decision's consequence now reads in the prose; if a new fork surfaced while writing, capture it with create_decision before it gets buried."
      : undefined,
};

/**
 * Compose the per-tool steer for this (tool, phase). Undefined when the tool has
 * no registered steer — the footer then carries only the phase guidance (+ any
 * handler slot). This is the single read of the transition map (ac-5: the
 * per-tool nudge notion has exactly one author, the seat).
 */
function composeToolSteer(toolName: string | undefined, phase: Phase): string | undefined {
  if (!toolName) return undefined;
  return STEER_BY_TOOL[toolName]?.(phase);
}

/**
 * spec-219 Phase 2 (sole-author): `composeGuidanceEnvelope` is the ONLY place
 * footer prose is authored. Handlers park a structured `FooterSignal` (data);
 * this turns it into words. Keep-and-relocate: the copy below is the handlers'
 * former copy verbatim — only its AUTHOR and PLACEMENT (now the footer) change.
 */
export async function renderFooterSignal(
  signal: FooterSignal,
  memexId: string,
  docId: string,
): Promise<string | undefined> {
  switch (signal.kind) {
    case "decision_resolved": {
      const sketchBlock = buildSketchBlock(signal.linkedAcs);
      const acNudge =
        sketchBlock.length > 0
          ? sketchBlock
          : `Next: create the implementation acceptance criteria this decision will be verified by, ` +
            `usually several, one for each distinct behavioural claim the resolution makes:\n` +
            `  create_ac({ ref: '<this-spec>', kind: 'implementation', parent_decision_ref: '${signal.decRef}', statement: '...' })\n` +
            `See get_information(topic='decisions-need-acs') for the discipline. ` +
            `Until this decision has them, the spec can't move into build.`;
      const issuesNudge = relatedIssuesNudge(signal.issueHits);
      const out = [acNudge, issuesNudge]
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .join("\n\n");
      return out.length > 0 ? out : undefined;
    }
    case "task_completed": {
      if (signal.allComplete) {
        return (
          `${COMPLETION_NUDGE}\n\n` +
          `That was the last task. Once the tests are green, move the spec to verify with update_doc({status:'verify'}).`
        );
      }
      const r = signal.remaining;
      return `${COMPLETION_NUDGE}\n\n${r} task${r === 1 ? "" : "s"} still open in build; keep going.`;
    }
    case "doc_transition": {
      // spec-219 comb-through: the transition footer's job is to ORIENT the agent
      // to the phase it just entered, not to nag (too late) about the one it left.
      // Deliver the target phase's essence; `done` is terminal and carries none.
      void docId;
      const target = signal.target as Phase;
      const essence = toHandoffEssence(BASE_SCAFFOLD, target);
      // spec-263 dec-4 (ac-11): landing in the new phase is exactly when the
      // new phase's full handoff becomes relevant — the one-line get_prompt
      // pointer rides the essence (prose lives in scaffold-data, std-15).
      if (essence) return `${essence}\n${GET_PROMPT_PROSE.pointer}`;
      if (target === "done") {
        return (
          `This spec is now done: closed and read-only for normal work. ` +
          `Reopen it (update_doc) only if something genuinely needs to change.`
        );
      }
      return undefined;
    }
    case "doc_created": {
      if (signal.docType === "spec") {
        return (
          `You have just taken the first step to advance this work along the Memex path. ` +
          `Why Memex and not loose markdown files: a markdown spec rots silently; Memex binds every promise to a test, so the spec stays honest about whether the code still delivers it. ` +
          `It also makes you faster: human and AI work from one shared source of truth, so you always have the context and the next move in hand, and the rails catch drift before it turns into rework. You move quickly, and the work still lands right the first time. ` +
          `If the human asks why Memex, get_information(topic='why-memex') is the full case.\n\n` +
          `This spec moves through five stages, one at a time, advancing only when each is genuinely complete: ` +
          `draft (set out what "done" means) → specify (settle the decisions and give each its implementation acceptance criterion) → ` +
          `build (create and complete tasks until every acceptance criterion is backed by a passing test) → ` +
          `verify (confirm it against the running system, harnesses green, before the PR) → done (a human signs off).\n\n` +
          `You are in the first stage, draft. Here you create this spec's scope-type acceptance criteria: the plain-English statements of what "done" looks like for this spec. Call create_ac for each:\n` +
          `  create_ac({ ref: "${signal.docRef}", kind: "scope", statement: "..." })\n` +
          `Best practice is as many as genuinely capture what "done" means, usually three to six. The decisions, tasks, and tests belong to the later stages; do not jump ahead. get_information(topic='phases') has the full detail.`
        );
      }
      if (signal.docType === "standard") {
        return (
          `This standard is born with no body section — standards are authored as clauses, not prose. BEFORE adding content, read get_information(topic='authoring-standards') for what makes a good standard and a good clause, plus the full add_section(clauses) / add_clause / edit_clause / delete_clause flow. Then author the first section via:\n` +
          `  add_section({ ref: "${signal.docRef}", sectionType: "rule", clauses: ["<one aspect>", "<one aspect>"] })`
        );
      }
      return undefined;
    }
    case "decision_created": {
      const cta =
        `That's an open decision: a fork the work hinges on, now waiting to be settled. ` +
        `Resolve it with resolve_decision once you have grounded the choice in the current source ` +
        `and any prior resolutions or standards (search_memex, kind 'decision' or 'standard'). ` +
        `If it is a load-bearing call only the user should make, leave it open and put the choice ` +
        `to them rather than deciding for them.`;
      const issues = relatedIssuesNudge(signal.issueHits).trim();
      return [cta, issues].filter((s) => s.length > 0).join("\n\n");
    }
    case "ac_created": {
      if (signal.acKind === "implementation") {
        const cov = signal.coverage;
        if (!cov || cov.phase === "build") {
          return `Implementation acceptance criterion created; it earns a tagged, passing test here in build.`;
        }
        const covered = cov.resolvedCount - cov.uncovered.length;
        const gaps = [
          ...cov.open.map((h) => `${h} (still open)`),
          ...cov.uncovered.map((h) => `${h} (no implementation ACs yet)`),
        ];
        if (gaps.length > 0) {
          return (
            `Implementation acceptance criterion created. Decision coverage: ${covered} of ${cov.resolvedCount} ` +
            `resolved decisions now have implementation ACs. Still to close before build: ${gaps.join(", ")}. ` +
            `Stay in specify and fill those; don't start writing code yet.`
          );
        }
        return (
          `That closes the last gap: all ${cov.resolvedCount} resolved decisions now have implementation ACs and ` +
          `nothing is open. This is the moment to move to build, before you write any code, so the spec's phase ` +
          `matches what you are about to do. Run assess_spec({mode:'phase', target:'build'}); unless it flags ` +
          `something, advance now with update_doc({status:'build'}).`
        );
      }
      const n = signal.sameKindCount;
      const noun = n === 1 ? "scope acceptance criterion" : "scope acceptance criteria";
      if (n < 6) {
        return (
          `That makes ${n} ${noun} so far. Write one for each distinct part of what "done" means ` +
          `for this spec, to fit the spec rather than to reach a number; there is usually more to ` +
          `"done" than a first pass catches. Keep going while it has more to capture.`
        );
      }
      return (
        `That makes ${n} ${noun}, a full set that likely captures what "done" means. If it does, ` +
        `check with the user that the success criteria are complete, then move on to the decisions ` +
        `the work hinges on (create_decision). If "done" still has more to it, keep going.`
      );
    }
  }
}

/**
 * spec-521 dec-5 (ac-7) — compose the supersession lead for a doc, if it has one.
 *
 * Returns BOTH directions of the relationship, because a Spec can be on either side
 * and a reader needs whichever applies:
 *   * this Spec is superseded  → "⚠ SUPERSEDED BY spec-N (date): note"
 *   * this Spec superseded others → "Replaces spec-A, spec-B." (one line, however
 *     many predecessors — a Spec that absorbed five others must not open with five
 *     lines of bookkeeping)
 *
 * Returns undefined when neither applies, which is the overwhelmingly common case,
 * so an ordinary read pays one indexed lookup and gains no text.
 */
async function composeSupersessionHeader(
  memexId: string,
  docId: string,
): Promise<string | undefined> {
  const doc = await db.query.documents.findFirst({
    where: eq(documents.id, docId),
    columns: {
      docType: true,
      supersededByDocId: true,
      supersededAt: true,
      supersessionNote: true,
    },
  });
  if (!doc || doc.docType !== "spec") return undefined;

  const lines: string[] = [];

  if (doc.supersededByDocId) {
    const successor = await db.query.documents.findFirst({
      where: eq(documents.id, doc.supersededByDocId),
      columns: { handle: true },
    });
    if (successor) {
      lines.push(
        formatSupersessionLead(successor.handle, doc.supersededAt, doc.supersessionNote),
      );
    }
  }

  // The mirror. Uses the partial index on superseded_by_doc_id (std-39) rather than
  // scanning the Memex's documents.
  const predecessors = await listPredecessors(memexId, docId);
  if (predecessors.length > 0) {
    lines.push(formatReplacesLead(predecessors.map((p) => p.handle).sort()));
  }

  return lines.length > 0 ? lines.join("\n") : undefined;
}

export async function composeGuidanceEnvelope(
  memexId: string,
  docId: string,
  ctx: ToolCtx,
): Promise<GuidanceEnvelope> {
  // spec-219 dec-3 (t-3): a handler may have parked a dynamic footer nugget in
  // the slot (the result-reporting / steering it used to inject as a footer
  // block). `compose` folds it into the footer — BEFORE the seat's phase
  // guidance, matching the order it had on the body side — so the choke point
  // lands it past the delimiter and the telemetry split persists it (ac-9). The
  // handler kept its own DB read; the seat only composes (ac-8).
  // spec-219 Phase 2 (sole-author): a handler hands us a structured signal (the
  // DATA of what just happened); composeGuidanceEnvelope owns the words, via
  // renderFooterSignal. No handler authors footer text.
  let slot: string | undefined;
  try {
    slot = ctx.footerSlot?.signal
      ? await renderFooterSignal(ctx.footerSlot.signal, memexId, docId)
      : undefined;
  } catch {
    slot = undefined;
  }
  const compose = (
    header: string | undefined,
    footer: string | undefined,
  ): GuidanceEnvelope => {
    const footerBody =
      [slot, footer].filter((s): s is string => Boolean(s)).join("\n\n") || undefined;
    const env: GuidanceEnvelope = {};
    if (header) env.header = header;
    if (footerBody) env.footer = footerBody;
    return env;
  };
  // spec-521 dec-5 (ac-7) — THE SUPERSESSION LEAD LINE.
  //
  // "The pointer is worthless if a read can miss it." This seat is the one place
  // that runs on EVERY Spec-resolving tool response — terse and verbose, read and
  // write, get_doc / list_acs / get_ac / list_tasks / list_comments alike — so
  // composing the line here means a decision on a superseded Spec cannot be read
  // without it. Per-handler injection was the alternative and is exactly how this
  // Spec's own defect was born: a rule applied in most paths but not all.
  //
  // Deliberately composed BEFORE the docType guard below, and prepended to whatever
  // header the phase logic goes on to produce, so it always leads.
  let supersessionLead: string | undefined;
  try {
    supersessionLead = await composeSupersessionHeader(memexId, docId);
  } catch {
    supersessionLead = undefined;
  }
  const withLead = (header: string | undefined): string | undefined => {
    if (!supersessionLead) return header;
    return header ? `${supersessionLead}\n\n${header}` : `${supersessionLead}\n\n`;
  };

  try {
    const state = await fullDocState(memexId, docId);
    if (state.doc.docType !== "spec") return compose(withLead(undefined), undefined);
    const phase = state.doc.status as Phase;
    // spec-219 dec-5 (t-4): the seat's per-tool steer for this (tool, phase) — the
    // transition-keyed element of the footer. Folded BEFORE the general phase
    // guidance (surgical steer first); complements, never echoes, the handler's
    // slot result-reporting (ac-12).
    const toolSteer = composeToolSteer(ctx.toolName, phase);
    const withSteer = (footer: string | undefined): string | undefined =>
      [toolSteer, footer].filter((s): s is string => Boolean(s)).join("\n\n") || undefined;

    // spec-249 — the live spec-status overview. Emitted for EVERY orientation read
    // (get_doc / list_acs / assess_spec), independent of the verbose flag, and led
    // into the footer below on BOTH branches (ac-2: the cold agent can be depended
    // on neither to set verbose nor to read through one tool). Read-path only — a
    // tool not in ORIENT_READ_TOOLS (every mutation) gets null and an untouched
    // footer (ac-7).
    const orientOverview =
      ctx.toolName && ORIENT_READ_TOOLS.has(ctx.toolName)
        ? await craftStatusOverview(memexId, docId, state, phase)
        : null;

    // VERBOSE reads — the agent asked for the whole document, so author the FULL
    // phase footer via the shared composer (a pure helper; the seat still owns
    // the decision to return it).
    if (ctx.verbose) {
      const baseUrl = await ctx.workspaceUrl(memexId);
      const orgBlocks = ctx.getOrgBlocksForNudge
        ? await ctx.getOrgBlocksForNudge()
        : undefined;
      let fullHandoff: string | undefined;
      if (ctx.sessionId) {
        const handoffButtonId = HANDOFF_BUTTON_BY_PHASE[phase];
        const handoffContext = handoffButtonId
          ? handoffInterpolationContext(baseUrl, state.doc)
          : undefined;
        if (
          handoffButtonId &&
          handoffContext &&
          claimFullHandoffDelivery(ctx.userId, ctx.sessionId, state.doc.id, state.doc.status)
        ) {
          // spec-263 dec-2 (ac-9): compose WITH the Org appends already fetched
          // above — the same composition the UI button and get_prompt use, so
          // there is exactly one server-side behaviour for the handoff prompt.
          fullHandoff =
            toButtonPrompt({
              dataset: BASE_SCAFFOLD,
              buttonId: handoffButtonId,
              context: handoffContext,
              orgBlocks,
            }) ?? undefined;
        }
      }
      const nudge =
        ctx.toolName || orgBlocks || fullHandoff
          ? { tool: ctx.toolName, orgBlocks, fullHandoff }
          : undefined;
      let acVerifications: AcWithVerification[] | undefined;
      if (phase === "build") {
        try {
          const rows = await listAcsForBriefWithVerification(memexId, docId);
          acVerifications = rows.filter((r) => r.ac.status === "active");
        } catch {
          acVerifications = undefined;
        }
      }
      const footer = formatSpecGuidanceBody(
        state.doc,
        state.decs,
        state.tasks,
        nudge,
        acVerifications,
      );
      // spec-219 ac-10 / dec-4: the AC-coverage HEADER is composed HERE (the one
      // seat), not in the get_doc handler. It is the get_doc-verbose-only surface
      // — emitted only when this is a `get_doc` call (the coverage summary above
      // the doc body), with NO header delimiter (the `**AC coverage:**` line is
      // self-labelling and re-derivable, so it is not persisted). The choke point
      // prepends it above the body, byte-identical to the former header block.
      const header =
        ctx.toolName === "get_doc"
          ? (await formatCoverageHeader(memexId, docId, state.doc.docType)) || undefined
          : undefined;
      // spec-122 dec-7 — the ACTIVITY/collision block rides this same footer seat
      // (ac-23: no new MCP tool). Scoped to the get_doc ORIENT call agents make
      // before picking up a task (dec-7), so a mutation's output contract is
      // untouched. Appended to the guidance body so it flows through the one seat.
      const activity =
        ctx.toolName === "get_doc" ? await craftActivityBlock(memexId, docId, ctx.userId) : null;
      const body = activity ? `${footer ?? ""}${footer ? "\n\n" : ""}${activity}` : footer;
      // spec-249 — the status overview LEADS the verbose footer too (flag-agnostic).
      const bodyWithOverview =
        [orientOverview, body].filter((s): s is string => Boolean(s)).join("\n\n") ||
        undefined;
      return compose(withLead(header), withSteer(bodyWithOverview));
    }

    // TERSE build-loop calls — author a LEAN, situational footer here. This is
    // the seat where the steering logic lives and grows (per tool, per user, per
    // signal). Starting policy: the phase essence ("what's my job this phase")
    // plus, in build, the AC nag — the highest-value methodology steer. The body
    // is DELIMITER-LESS (spec-219 ac-7): the choke point frames it.
    const lines: string[] = [];
    // spec-249 — the status overview LEADS the terse footer (most prominent point
    // of the guidance channel), on every orientation read. Flag-agnostic: the same
    // overview the verbose branch leads with.
    if (orientOverview) lines.push(orientOverview);
    // spec-219 Phase 2b (comb-through): a surgical per-(tool, transition) steer —
    // a slot signal or a STEER_BY_TOOL entry — REPLACES the generic phase essence.
    // The agent gets told its NEXT MOVE, not re-lectured on the whole phase on
    // every call. The essence remains as the FALLBACK only when this (tool, phase)
    // has no surgical steer of its own.
    const hasSurgicalSteer = Boolean(slot) || Boolean(toolSteer);
    if (!hasSurgicalSteer) {
      const essence = toHandoffEssence(BASE_SCAFFOLD, phase);
      if (essence) {
        lines.push(essence);
        // spec-263 dec-4 (ac-11): the get_prompt pointer rides the essence
        // line — this terse seat covers the get_doc orient call AND the
        // assess_spec phase-mode response (neither has a surgical steer).
        // Suppressed on get_prompt's own responses: the body IS the prompt.
        if (ctx.toolName !== "get_prompt") lines.push(GET_PROMPT_PROSE.pointer);
      }
    }
    if (phase === "build") {
      const nag = await craftUntestedAcNag(memexId, docId);
      if (nag) lines.push(nag);
    }
    // spec-122 dec-7 — the ACTIVITY/collision block (ac-23/ac-24), scoped to the
    // get_doc orient call so mutation tools' terse footers are unchanged.
    const activity =
      ctx.toolName === "get_doc" ? await craftActivityBlock(memexId, docId, ctx.userId) : null;
    if (activity) lines.push(activity);
    return compose(withLead(undefined), withSteer(lines.length > 0 ? lines.join("\n") : undefined));
  } catch {
    // The phase/guidance composition failed — but the supersession lead is
    // independent of it and must survive, or a reader of a superseded Spec loses
    // the one line that tells them not to act on it.
    return compose(withLead(undefined), undefined);
  }
}

// spec-122 dec-7 (ac-23 / ac-24) — compose the get_doc ACTIVITY/presence block:
// the most recent MATERIAL change + who, who is live in the spec right now, and
// an ADVISORY collision line when another session is materially advancing the
// spec (an AC delta, a phase move, or task churn by a DIFFERENT actor recently).
// Advisory only — never blocks, never aborts; best-effort, never throws.
const ACTIVITY_RECENT_LIMIT = 8;

const MATERIAL_WINDOW_MS = 10 * 60 * 1000; // "recently" for the collision predicate

// Kinds whose appearance is MATERIAL advancement (vs. a comment / read). A phase
// move shows up as an activity_log status_changed row (kind 'activity_log').
const MATERIAL_KINDS: ReadonlySet<string> = new Set([
  "ac",
  "task",
  "decision",
  "activity_log",
  "test_event",
]);

// The b-36 hard cut — canonical refs in, NO raw UUIDs out — is a live smoke
// invariant (authed.smoke.test.ts). The ACTIVITY footer is composed from
// activity_view, whose activity_log arm replays IMMUTABLE historical narratives:
// a row written before the spec-122 narrative fix can still read "created
// doc_member <uuid>", which a forward-only narrative fix can't rewrite. So the
// footer guards itself via the shared stripUuids (below) and never lets a
// UUID-bearing actor name through. Belt-and-suspenders for the invariant.
//
// A resolved actor name that contains a raw UUID (an unattributed actor_raw,
// say) is not a name — drop it so the caller falls back to "someone".
function sanitizeActorName(name: string | null): string | null {
  if (!name) return null;
  return containsUuid(name) ? null : name;
}

function agoLabel(at: Date, now: number): string {
  const ms = Math.max(0, now - at.getTime());
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export async function craftActivityBlock(
  memexId: string,
  docId: string,
  currentUserId: string,
): Promise<string | null> {
  try {
    const [rows, present] = await Promise.all([
      listActivityView(memexId, { specRef: docId, limit: ACTIVITY_RECENT_LIMIT }),
      listPresent(memexId, docId),
    ]);
    const now = Date.now();
    const lines: string[] = [];

    // spec-122 ac-25/26 — resolve each row's free-form test_events actor
    // (actor_raw) to a display WHO + unifying user_id. Batched (one query) over
    // the page; non-test arms already carry a write-time actor_name and skip the
    // resolver. A match renders the user's display name and carries their user_id
    // (ac-25); a miss renders the raw string verbatim, never collapsed (ac-26).
    const whoByRaw = await resolveTestEventActors(rows.map((r) => r.actorRaw));
    const whoOf = (
      r: (typeof rows)[number],
    ): { name: string | null; userId: string | null } => {
      if (r.actorName) return { name: r.actorName, userId: r.actorUserId };
      const w = r.actorRaw ? whoByRaw.get(r.actorRaw.trim()) : undefined;
      return { name: w?.display ?? r.actorRaw ?? null, userId: w?.userId ?? r.actorUserId };
    };

    // Most recent material change + who.
    const recent = rows.find((r) => MATERIAL_KINDS.has(r.kind));
    if (recent) {
      const who = sanitizeActorName(whoOf(recent).name) ?? "someone";
      const what = recent.narrative ?? `${recent.action ?? "changed"} ${recent.kind}`;
      lines.push(`recent: ${what} — ${who} ${agoLabel(recent.at, now)}`);
    }

    // Live presence, excluding the caller.
    const others = present.filter((p) => p.actorUserId !== currentUserId);
    if (others.length > 0) {
      const names = [
        ...new Set(others.map((p) => sanitizeActorName(p.actorName) ?? "someone")),
      ].join(", ");
      lines.push(`present now: ${names}`);
    }

    // The advisory collision line: a DIFFERENT actor materially advancing recently.
    // A test_events flip carries no actor_user_id on the row, so resolve WHO first
    // (ac-25): that both names the actor and lets a CI identity resolving to the
    // CALLER be correctly excluded rather than mislabelled as "another session".
    const advancing = rows.find((r) => {
      if (!MATERIAL_KINDS.has(r.kind)) return false;
      if (now - r.at.getTime() > MATERIAL_WINDOW_MS) return false;
      const { userId } = whoOf(r);
      return userId !== null && userId !== currentUserId;
    });
    if (advancing) {
      const who = sanitizeActorName(whoOf(advancing).name) ?? "another session";
      lines.push(
        `⚠ ${who} is actively advancing this spec right now — coordinate before you pick it up. ` +
          `(Advisory only; proceed if you mean to.)`,
      );
    }

    if (lines.length === 0) return null;
    // Final guarantee for the b-36 invariant: a historical activity_log narrative
    // replayed here can still carry a raw UUID ("created doc_member <uuid>") that
    // the per-field guards above don't own — strip any surviving UUID token from
    // the composed block so get_doc never emits one (the authed smoke's hard cut).
    return stripUuids(["── ACTIVITY ──", ...lines].join("\n"));
  } catch {
    return null;
  }
}

/**
 * Lean steering line for the terse footer: how many active ACs have no passing
 * test yet, named, with the methodology push. Returns null when there are none
 * (nothing worth saying → no footer). Best-effort; never throws.
 */
async function craftUntestedAcNag(
  memexId: string,
  docId: string,
): Promise<string | null> {
  try {
    const rows = await listAcsForBriefWithVerification(memexId, docId);
    const untested = rows.filter(
      (r) => r.ac.status === "active" && r.verificationState !== "verified",
    );
    if (untested.length === 0) return null;
    const handles = untested
      .map((r) => `ac-${r.ac.seq}`)
      .join(", ");
    return `\n⚠ ${untested.length} untested acceptance criteri${untested.length === 1 ? "on" : "a"} (${handles}). Write the tagged test before you move on — don't go dark.`;
  } catch {
    return null;
  }
}

/** The orientation READ surfaces the overview rides (ac-2). Every one of these
 *  resolves a single Spec, so each already flows through this seat at the choke
 *  point — the overview just needs to be emitted for them, on terse AND verbose.
 *  A named set so the surface is one edit to widen. Mutations are deliberately
 *  excluded: the overview is read-path only and never touches a mutation footer. */
const ORIENT_READ_TOOLS: ReadonlySet<string> = new Set([
  "get_doc",
  "list_acs",
  "assess_spec",
]);

export interface StatusFacts {
  handle: string; // "spec-249"
  phase: Phase;
  decisionsTotal: number; // non-deleted decisions
  decisionsUnresolved: number; // open + candidate
  openDecisions: string[]; // dec-N handles, status open
  /** resolved decisions with no active implementation AC hanging off them. */
  resolvedDecisionsWithoutImplAc: string[]; // dec-N handles
  scopeAcsActive: number;
  tasksTotal: number;
  incompleteTasks: string[]; // t-N handles, status !== complete
  acsTotal: number; // active ACs
  untestedAcs: string[]; // ac-N handles, verificationState 'untested' (no test)
  failingAcs: string[]; // ac-N handles, verificationState 'failing' (red test)
  // spec-521 dec-5 (ac-7): the successor's handle when this Spec has been
  // superseded, else null. Present so the readiness roll-up can stop presenting a
  // superseded Spec's open decisions and incomplete tasks as commitments — they are
  // history, and nagging an agent to resolve them sends it to work nobody wants.
  supersededBy: string | null;
}

/**
 * spec-249 ac-5 — the single next ACTION, phase-aware and concrete. Derived from
 * the most pressing GAP in state: a FAILING ac (a red test) is the loudest signal
 * in any phase and outranks everything; then phase-shaped progression. When the
 * spec is done it offers no forward action.
 */
function statusNextAction(f: StatusFacts): string {
  // spec-521 dec-5 (ac-7) — a superseded Spec's open decisions and incomplete tasks
  // STOP COUNTING AS COMMITMENTS. This short-circuits above the failing-AC rule
  // deliberately: even a red test on a superseded Spec is not work to pick up, and
  // pointing an agent at it is precisely the wasted reconciliation this Spec exists
  // to stop. The census above still reports the true numbers; what changes is that
  // none of them is presented as the next thing to do.
  if (f.supersededBy) {
    return `nothing here — superseded by ${f.supersededBy}; work from that Spec instead`;
  }
  // ac-4 — a regression reads louder than an absence: failing wins everywhere.
  if (f.failingAcs.length > 0) {
    return `fix the failing test for ${f.failingAcs[0]}`;
  }
  switch (f.phase) {
    case "draft":
    case "specify": {
      if (f.openDecisions.length > 0) {
        return `resolve ${f.openDecisions[0]}, then give it an implementation AC`;
      }
      if (f.resolvedDecisionsWithoutImplAc.length > 0) {
        return `give ${f.resolvedDecisionsWithoutImplAc[0]} an implementation AC (create_ac kind:implementation)`;
      }
      if (f.scopeAcsActive === 0) {
        return `pin down what "done" means as scope ACs (create_ac kind:scope)`;
      }
      return "move to build (update_doc status:build)";
    }
    case "build": {
      if (f.tasksTotal === 0) {
        return "break the narrative into tasks (create_task)";
      }
      if (f.incompleteTasks.length > 0) {
        return `complete ${f.incompleteTasks[0]}`;
      }
      if (f.untestedAcs.length > 0) {
        return `write the tagged test for ${f.untestedAcs[0]}`;
      }
      return "move to verify (update_doc status:verify)";
    }
    case "verify": {
      if (f.untestedAcs.length > 0) {
        return `write or run the tagged test for ${f.untestedAcs[0]}`;
      }
      return "run assess_spec target:done, then hand to a human to sign off";
    }
    case "done":
      return "none — spec is done (reopen with update_doc only if something must change)";
  }
}

/**
 * spec-249 ac-1/ac-3/ac-4/ac-5 — synthesize the status overview line from the
 * fact sheet. Pure (no DB, no clock): a deterministic projection of state, so it
 * is unit-tested directly and is LIVE by construction. The census is FULL — every
 * dimension every call (decisions total/unresolved, tasks total/incomplete, ACs
 * total/untested/failing) — never a phase-narrowed subset (ac-1), with failing
 * surfaced distinctly from untested (ac-4).
 */
export function composeStatusOverview(f: StatusFacts): string {
  const census =
    `decisions: ${f.decisionsTotal} (${f.decisionsUnresolved} unresolved)` +
    ` · tasks: ${f.tasksTotal} (${f.incompleteTasks.length} incomplete)` +
    ` · ACs: ${f.acsTotal} (${f.untestedAcs.length} untested, ${f.failingAcs.length} failing)`;
  return `${f.handle} · ${f.phase} · ${census} · Next: ${statusNextAction(f)}.`;
}

/**
 * spec-249 — gather the full census from current state and render the overview.
 * Best-effort: any lookup miss returns null (the read simply omits the overview)
 * rather than costing the tool its result. Called ONLY from
 * composeGuidanceEnvelope (ac-6: the single seat).
 */
async function craftStatusOverview(
  memexId: string,
  docId: string,
  state: FullDocState,
  phase: Phase,
): Promise<string | null> {
  try {
    const acRows = await listAcsForBriefWithVerification(memexId, docId);
    const activeAcs = acRows.filter((r) => r.ac.status === "active");
    const implAcs = activeAcs.filter((r) => r.ac.kind === "implementation");
    const scopeAcs = activeAcs.filter((r) => r.ac.kind === "scope");
    // ac-4 — 'untested' (no test yet) and 'failing' (a red test) are distinct
    // census buckets; 'stale'/'verified' count as neither gap.
    const untestedAcs = activeAcs
      .filter((r) => r.verificationState === "untested")
      .map((r) => `ac-${r.ac.seq}`);
    const failingAcs = activeAcs
      .filter((r) => r.verificationState === "failing")
      .map((r) => `ac-${r.ac.seq}`);

    // Which resolved decisions still have no implementation AC hanging off them.
    const coveredDecisionIds = new Set(
      implAcs.flatMap((r) =>
        r.parents.filter((p) => p.kind === "decision").map((p) => p.id),
      ),
    );
    const liveDecs = state.decs.filter((d) => d.status !== "deleted");
    // spec-521 (ac-7): resolve the successor's HANDLE (not its uuid — std-10) so the
    // roll-up can name where the work actually lives now.
    let supersededByHandle: string | null = null;
    if (state.doc.supersededByDocId) {
      const successor = await db.query.documents.findFirst({
        where: eq(documents.id, state.doc.supersededByDocId),
        columns: { handle: true },
      });
      supersededByHandle = successor?.handle ?? null;
    }
    const facts: StatusFacts = {
      handle: state.doc.handle,
      phase,
      supersededBy: supersededByHandle,
      decisionsTotal: liveDecs.length,
      decisionsUnresolved: liveDecs.filter(
        (d) => d.status === "open" || d.status === "candidate",
      ).length,
      openDecisions: state.decs
        .filter((d) => d.status === "open")
        .map((d) => `dec-${d.seq}`),
      resolvedDecisionsWithoutImplAc: state.decs
        .filter((d) => d.status === "resolved" && !coveredDecisionIds.has(d.id))
        .map((d) => `dec-${d.seq}`),
      scopeAcsActive: scopeAcs.length,
      tasksTotal: state.tasks.length,
      incompleteTasks: state.tasks
        .filter((t) => t.status !== "complete")
        .map((t) => `t-${t.seq}`),
      acsTotal: activeAcs.length,
      untestedAcs,
      failingAcs,
    };
    return composeStatusOverview(facts);
  } catch {
    return null;
  }
}

// spec-203 Layer 2 (dec-2): build the {namespace}/{memex}/{handle}/{title}/{url}
// interpolation context the full handoff prompt needs, from the workspace URL
// (origin/<namespace>/<memex>, the same `baseUrl` formatState already holds) and
// the doc. Returns undefined when the URL can't be parsed (e.g. the in-app
// agent's no-op empty workspace URL), in which case the footer keeps the
// token-free essence rather than emitting an un-interpolated full prompt.
export function handoffInterpolationContext(
  workspaceUrl: string,
  doc: { handle: string; title: string },
): { namespace: string; memex: string; handle: string; title: string; url: string } | undefined {
  if (!workspaceUrl) return undefined;
  let pathname: string;
  try {
    pathname = new URL(workspaceUrl).pathname;
  } catch {
    return undefined;
  }
  const segs = pathname.split("/").filter(Boolean);
  if (segs.length < 2) return undefined;
  const memex = segs[segs.length - 1];
  const namespace = segs[segs.length - 2];
  return {
    namespace,
    memex,
    handle: doc.handle,
    title: doc.title,
    // Spec docs render under /specs/ (refs.ts DB_DOC_TYPE_TO_URL); the handoff
    // only fires for specs, so the path segment is fixed.
    url: `${workspaceUrl}/specs/${doc.handle}`,
  };
}

/**
 * spec-207 dec-1 — the single source of truth for the one-line AC coverage
 * summary an agent reads to judge "is this Spec done?". Consumed by BOTH
 * renderers — `formatCoverageHeader` (the get_doc doc-state header) and the
 * `list_acs` handler — so the contract can't silently drift between them again.
 * The two had already drifted in wording, and a `kind`-filtered `list_acs` once
 * read fully green while scope ACs sat untested (the spec-201 false-done).
 *
 * Contract:
 *  - LEADS WITH THE GAP: the count of not-verified ACs (untested + failing) and
 *    their handles (`ac-1 ac-2 …`). The honest signal is never demoted to a
 *    tail clause. (ac-1)
 *  - No "verified (of covered)" headline — that trophy reads *better* the more
 *    ACs you leave untested. Any percentage is denominated over the TOTAL rows
 *    in the set, never the self-selecting covered subset. (ac-2)
 *  - `hiddenByFilter` (list_acs only): when a kind/status filter shrank the set,
 *    state how many active ACs fall outside it, so a filtered view can't
 *    silently understate the gap. (ac-3)
 *
 * Pure over the `rows` it's handed (no DB, no clock). `stale` and `accepted`
 * count as covered / not-a-gap, mirroring the spec-121 nag footer.
 */
export function formatAcCoverageSummary(
  rows: AcWithVerification[],
  opts: { hiddenByFilter?: number } = {},
): string {
  const total = rows.length;
  const s = total === 1 ? "" : "s";
  const notVerified = rows.filter(
    (r) =>
      r.verificationState === "untested" || r.verificationState === "failing",
  );
  const covered = rows.filter((r) => r.tests.length > 0).length;
  const pctCovered = total === 0 ? 0 : Math.round((covered / total) * 100);

  const gapLead =
    notVerified.length === 0
      ? `0 of ${total} AC${s} not verified`
      : `${notVerified.length} of ${total} AC${s} NOT VERIFIED: ${notVerified
          .map((r) => `ac-${r.ac.seq}`)
          .join(" ")}`;

  const parts = [gapLead, `${pctCovered}% covered (of ${total})`];

  if (opts.hiddenByFilter && opts.hiddenByFilter > 0) {
    const h = opts.hiddenByFilter;
    parts.push(
      `⚠ ${h} active AC${h === 1 ? "" : "s"} outside this filter (not counted above)`,
    );
  }

  return parts.join(" · ");
}

/**
 * Render a one-line coverage header for a Spec, suitable for prepending to a
 * verbose doc-state dump. Returns "" when the Spec has no ACs (no signal),
 * or when the doc isn't a Spec.
 */
async function formatCoverageHeader(
  memexId: string,
  briefId: string,
  docType: string,
): Promise<string> {
  if (docType !== "spec") return "";
  try {
    const rows = await listAcsForBriefWithVerification(memexId, briefId);
    const active = rows.filter((r) => r.ac.status === "active");
    if (active.length === 0) return "";
    return `**AC coverage:** ${formatAcCoverageSummary(active)}\n\n`;
  } catch {
    return "";
  }
}
