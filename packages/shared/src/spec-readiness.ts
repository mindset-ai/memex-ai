// doc-12: shared spec-readiness logic.
//
// One canonical computation of "what's outstanding before a forward Spec
// phase transition" so both surfaces (React UI affordances + server's
// MCP/agent tool nudges) speak with one voice. Pure — no I/O, no globals.

export type SpecPhase = 'draft' | 'specify' | 'build' | 'verify' | 'done';

const PHASE_ORDER: Record<SpecPhase, number> = {
  draft: 0,
  specify: 1,
  build: 2,
  verify: 3,
  done: 4,
};

export type DecisionStatusForReadiness = 'open' | 'resolved' | 'candidate' | 'rejected';

export type DecisionForReadiness = {
  id: string;
  createdAt: string | Date;
  resolvedAt: string | Date | null;
  // status is the source of truth for "is this an open decision blocking us?".
  // resolvedAt was the previous proxy and leaked candidate / rejected rows into
  // the unresolved count when their resolvedAt happened to be null.
  status: DecisionStatusForReadiness;
};

export type CommentTypeBreakdown = Partial<
  Record<'note' | 'question' | 'drift' | 'plan_revision', number>
>;

export type ReadinessInput = {
  currentPhase: SpecPhase;
  decisions: DecisionForReadiness[];
  openCommentCount: number;
  openCommentsByType?: CommentTypeBreakdown;
  narrativeLastConsolidatedAt: string | Date | null | undefined;
  /**
   * spec-112 t-8: count of Issues that are still in flight (`open` + `converted`)
   * on this Spec. Resolved / wont_fix Issues are settled and don't count. Drives
   * a SOFT verify→done warning only (never a block) — closing a Spec with bugs or
   * todos still open is worth a second look, but it's the human's call (ac-17 /
   * ac-18). Optional so existing callers that don't yet thread Issue counts keep
   * working — absent / 0 means no issue warning.
   */
  openIssueCount?: number;
};

export type OutstandingItem =
  | { kind: 'unresolved_comments'; count: number; label: string; cta: string }
  | { kind: 'unresolved_decisions'; count: number; label: string; cta: string }
  | { kind: 'stale_narrative'; staleDecisionCount: number; label: string; cta: string }
  // spec-112 t-8: open + converted Issues outstanding at the verify→done gate.
  // SOFT signal — surfaced as a warning, never a hard block (ac-17 / ac-18).
  | { kind: 'open_issues'; count: number; label: string; cta: string };

export type SpecReadiness = {
  outstandingItems: OutstandingItem[];
  isClean: boolean;
};

const RESOLVE_COMMENTS_CTA =
  'Use the "Resolve Comments" button to walk them with the agent.';
// spec-196 dec-3/dec-1: human-facing copy says "spec narrative"; the live
// affordance is the opening-turn "Update spec narrative" helper (spec-123),
// not the retired top-bar button.
const REFRESH_SPEC_CTA =
  'Use the "Update spec narrative" helper to consolidate.';
const RESOLVE_DECISIONS_CTA =
  'Resolve them on the Decisions tab — tasks are first-class only once decisions are settled.';
const OPEN_ISSUES_CTA =
  'Resolve, convert, or mark them wont_fix on the Issues tab before closing the Spec — or close anyway if this was intentional.';

function toMillis(value: string | Date | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function decisionLastTouched(d: DecisionForReadiness): number {
  const created = toMillis(d.createdAt) ?? 0;
  const resolved = toMillis(d.resolvedAt) ?? 0;
  return Math.max(created, resolved);
}

/**
 * Count decisions whose last-touched timestamp is newer than the consolidation
 * anchor. If `narrativeLastConsolidatedAt` is null/undefined every existing
 * decision counts as stale (the narrative has never captured them).
 */
export function countStaleDecisions(
  narrativeLastConsolidatedAt: string | Date | null | undefined,
  decisions: DecisionForReadiness[],
): number {
  if (decisions.length === 0) return 0;
  const consolidatedAt = toMillis(narrativeLastConsolidatedAt);
  if (consolidatedAt === null) return decisions.length;
  return decisions.filter((d) => decisionLastTouched(d) > consolidatedAt).length;
}

/**
 * True when at least one decision is newer than the last consolidation (or
 * the Spec has never been consolidated and has any decisions). Drop-in
 * replacement for the local helper that lived in RefreshBriefButton.
 */
export function isSpecNarrativeStale(
  narrativeLastConsolidatedAt: string | Date | null | undefined,
  decisions: DecisionForReadiness[],
): boolean {
  return countStaleDecisions(narrativeLastConsolidatedAt, decisions) > 0;
}

export function isForwardTransition(from: SpecPhase, to: SpecPhase): boolean {
  return PHASE_ORDER[to] > PHASE_ORDER[from];
}

export function isBackwardTransition(from: SpecPhase, to: SpecPhase): boolean {
  return PHASE_ORDER[to] < PHASE_ORDER[from];
}

/** True only for forward transitions when there are outstanding items. */
export function shouldBlockForwardTransition(
  readiness: SpecReadiness,
  from: SpecPhase,
  to: SpecPhase,
): boolean {
  if (!isForwardTransition(from, to)) return false;
  return !readiness.isClean;
}

/** Count decisions that are still open (status === 'open'). Candidates,
 * resolved, and rejected decisions are intentionally excluded — only an
 * `open` decision is an active blocker for a forward phase transition. */
export function countUnresolvedDecisions(decisions: DecisionForReadiness[]): number {
  return decisions.filter((d) => d.status === 'open').length;
}

/** Pure computation. Same inputs → same outputs. */
export function computeSpecReadiness(input: ReadinessInput): SpecReadiness {
  const items: OutstandingItem[] = [];

  // Unresolved decisions block first — moving forward (especially into `build`
  // where tasks are first-class) without settling decisions makes any task a
  // guess pretending to be a commitment. Per dec-1 of doc-12 + the "tasks only
  // in build" non-negotiable rule.
  const unresolvedDecisions = countUnresolvedDecisions(input.decisions);
  if (unresolvedDecisions > 0) {
    const noun = unresolvedDecisions === 1 ? 'unresolved decision' : 'unresolved decisions';
    items.push({
      kind: 'unresolved_decisions',
      count: unresolvedDecisions,
      label: `${unresolvedDecisions} ${noun}`,
      cta: RESOLVE_DECISIONS_CTA,
    });
  }

  if (input.openCommentCount > 0) {
    const noun = input.openCommentCount === 1 ? 'open comment' : 'open comments';
    items.push({
      kind: 'unresolved_comments',
      count: input.openCommentCount,
      label: `${input.openCommentCount} ${noun}`,
      cta: RESOLVE_COMMENTS_CTA,
    });
  }

  const staleCount = countStaleDecisions(
    input.narrativeLastConsolidatedAt,
    input.decisions,
  );
  if (staleCount > 0) {
    const noun = staleCount === 1 ? 'decision' : 'decisions';
    items.push({
      kind: 'stale_narrative',
      staleDecisionCount: staleCount,
      label: `${staleCount} ${noun} not yet reflected in the narrative`,
      cta: REFRESH_SPEC_CTA,
    });
  }

  // spec-112 t-8: open + converted Issues are a verify→done concern only. An
  // Issue that's still `open` (the bug/todo isn't fixed) or `converted` (its
  // satisfying Task hasn't proven green) means there's in-flight work the Spec
  // claims to be done about. We surface it ONLY when the Spec is sitting in
  // `verify` — the phase you transition to `done` FROM — so it never noises up
  // the earlier specify→build / build→verify gates. SOFT: it adds a warning item
  // but `done` is never blocked on it (ac-17 / ac-18). `resolved` / `wont_fix`
  // Issues are settled and were already excluded by the caller's count.
  const openIssueCount = input.openIssueCount ?? 0;
  if (input.currentPhase === 'verify' && openIssueCount > 0) {
    const noun = openIssueCount === 1 ? 'open or converted Issue' : 'open or converted Issues';
    items.push({
      kind: 'open_issues',
      count: openIssueCount,
      label: `${openIssueCount} ${noun}`,
      cta: OPEN_ISSUES_CTA,
    });
  }

  return {
    outstandingItems: items,
    isClean: items.length === 0,
  };
}

/**
 * Convenience: human-readable lines for a confirm dialog or MCP response.
 * One line per outstanding item, formatted like:
 *   `3 decisions not yet reflected in the narrative — Use the "Update spec narrative" helper to consolidate.`
 */
export function blockerLines(readiness: SpecReadiness): string[] {
  return readiness.outstandingItems.map((item) => `${item.label} — ${item.cta}`);
}

// ---------------------------------------------------------------------------
// spec-189: traffic-driven phase advancement.
//
// Agent tool traffic (channels 'mcp' / 'in_app_agent') is classified by the
// @memex/shared tool manifest into a TrafficClass; this pure function is THE
// single place (spec-189 ac-3) that decides whether observed traffic moves a
// Spec. The server applies the result through updateDocStatus() → mutate() →
// bus (std-8); nothing else may re-encode these rules.
//
// The matrix (spec-189 dec-1, dec-2, dec-3):
//
//   current ↓ / traffic →   specify     build      verify
//   draft                   → specify   → build    → verify
//   specify                 stay        → build    stay
//   build                   stay        stay       stay
//   verify                  stay        stay       stay
//   done                    → specify   → build    → verify
//
//   - `null` (query-class) traffic never moves a Spec.
//   - draft is special: ANY classified traffic re-homes the Spec to the
//     class's phase — a draft with traffic arriving is beyond sketching.
//   - done is reopenable by activity: traffic moves it BACK to the class's
//     phase.
//   - between those open ends, motion is forward-only and only build-class
//     traffic drives it (specify → build). Entering verify is never
//     traffic-driven from specify/build; verify never regresses to build.
//   - transitions are unconditional (dec-3) — readiness gating stays soft
//     per spec-12 dec-6 and is not consulted here.

/**
 * How a tool's traffic reads against the Spec lifecycle. Values deliberately
 * mirror the SpecPhase the traffic "belongs" to; `null` is query-class
 * (read-only) traffic, which never moves a Spec and never assigns.
 */
export type TrafficClass = 'specify' | 'build' | 'verify' | null;

/**
 * The pure transition function: (current phase × traffic class) → next phase.
 * Returns the unchanged phase when the traffic doesn't move the Spec. Zero
 * I/O; exhaustively unit-tested cell-by-cell.
 */
export function nextPhaseForTraffic(
  current: SpecPhase,
  traffic: TrafficClass,
): SpecPhase {
  if (traffic === null) return current;

  // TrafficClass values are SpecPhase names by construction — the class IS
  // the phase the traffic re-homes a Spec to from the open ends.
  const target: SpecPhase = traffic;

  // The open ends: draft (any traffic means we're beyond sketching) and done
  // (reopenable by activity) re-home to the class's phase.
  if (current === 'draft' || current === 'done') return target;

  // Between the ends: forward-only, and only build-class traffic drives it.
  if (traffic === 'build' && isForwardTransition(current, 'build')) {
    return 'build';
  }

  return current;
}
