import { useState } from 'react';
import { updateDocStatus } from '../api/client';
import { SPEC_STATUSES, type SpecStatus } from '../api/types';
import { Button } from './ui';

// spec-159 t-3: the Rubicon line — the single sentence beneath the phase tabs
// that always states the EXACT condition of the readiness rubric (dec-4, second
// amendment, 2026-06-04; shortened 2026-06-04: the "This spec is currently in
// {phase}." lead is gone — the tab bar's filled current-phase pill already
// says where we are).
//
// Three shapes, keyed on what the user is viewing:
//
//   1. CURRENT tab, rubric clean → the advancement offer + [Yes].
//      "Do you wish to move this spec to build?"
//   2. CURRENT tab, rubric blocked → the outstanding work, stated plainly, NO
//      buttons — when the work is obvious there is nothing to confirm.
//      "**4 Decisions** must be resolved and **Acceptance Criteria (ACs)**
//       must be created before this spec can move to build."
//   3. BROWSING another tab → an explicit confirm: [Yes] [No]. Forward+blocked
//      leads with the blocker summary (which names the target) and asks "Move
//      this spec anyway?" — the deliberate-friction escape hatch. No returns
//      the view to the current phase's tab. Backward moves never carry
//      blockers (dec-5).
//
// The sentence renders for every viewer — it is the page's phase status line —
// and the buttons gate on `canTransition` (editor posture, i-1). Pressing Yes
// is the only thing that moves the phase, anywhere on the page.

// `draft` is treated as "before plan": its home is the Plan tab, draft → plan
// is never gated, and the forward target of every phase is simply the next
// entry in SPEC_STATUSES.
function nextPhase(phase: SpecStatus): SpecStatus | null {
  const idx = SPEC_STATUSES.indexOf(phase);
  return idx >= 0 && idx < SPEC_STATUSES.length - 1 ? SPEC_STATUSES[idx + 1] : null;
}

function phaseOrder(phase: SpecStatus): number {
  return SPEC_STATUSES.indexOf(phase);
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** One blocker = an emphasised entity + its "must be …" requirement. Fragments
 * sharing the same requirement merge their entities: "Decisions and Acceptance
 * Criteria (ACs) must be created…" rather than repeating the verb. */
interface BlockerPart {
  em: string;
  rest: string;
}

export interface TransitionSentenceProps {
  /** The Spec being transitioned — only its id is needed for the API call. */
  doc: { id: string };
  /** The Spec's live phase. */
  currentPhase: SpecStatus;
  /** The tab the user is currently looking at. draft's home tab is `plan`. */
  viewedTab: SpecStatus;
  /**
   * Whether the viewer may actually move the phase (editor posture + org write
   * access). When false the sentence still renders — it's the page's phase
   * status line — but the Yes/No buttons are withheld.
   */
  canTransition?: boolean;
  /** Total decisions on the Spec — distinguishes "none created" from "open". */
  totalDecisionCount?: number;
  /** Unresolved decisions (shared countUnresolvedDecisions semantics). */
  openDecisionCount?: number;
  /** Whether any active acceptance criteria exist (plan→build AND verify→done axes). */
  hasAcceptanceCriteria?: boolean;
  /** Total tasks on the Spec — distinguishes "none created" from "open" (build axis). */
  totalTaskCount?: number;
  /** Still-open tasks (build→verify axis). */
  openTaskCount?: number;
  /** Active-but-unverified ACs (verify→done axis). */
  unverifiedAcCount?: number;
  /** Fired after a successful transition so the parent can refetch / re-render. */
  onTransitioned?: (newPhase: SpecStatus) => void;
  /** The browse-confirm's [No]: return the view to the current phase's tab. */
  onCancelBrowse?: () => void;
}

/**
 * The rubric's outstanding work for advancing OUT of `currentPhase`. Empty =
 * ready to advance. Each part reads "<entity> must be <verbed>"; the renderer
 * merges parts that share a requirement.
 */
function blockerFragments(p: {
  currentPhase: SpecStatus;
  totalDecisionCount: number;
  openDecisionCount: number;
  hasAcceptanceCriteria: boolean;
  totalTaskCount: number;
  openTaskCount: number;
  unverifiedAcCount: number;
}): BlockerPart[] {
  const parts: BlockerPart[] = [];
  if (p.currentPhase === 'plan') {
    if (p.totalDecisionCount === 0) {
      parts.push({ em: 'Decisions', rest: 'must be created' });
    } else if (p.openDecisionCount > 0) {
      parts.push({ em: plural(p.openDecisionCount, 'Decision'), rest: 'must be resolved' });
    }
    if (!p.hasAcceptanceCriteria) {
      parts.push({ em: 'Acceptance Criteria (ACs)', rest: 'must be created' });
    }
  } else if (p.currentPhase === 'build') {
    // A build with NO tasks at all hasn't built anything — that's as blocked
    // as open tasks (the zero-task hole let an empty build offer verify).
    if (p.totalTaskCount === 0) {
      parts.push({ em: 'Tasks', rest: 'must be created and completed' });
    } else if (p.openTaskCount > 0) {
      parts.push({ em: plural(p.openTaskCount, 'Task'), rest: 'must be completed' });
    }
  } else if (p.currentPhase === 'verify') {
    // Same hole: a verify with no active ACs has nothing to verify against.
    if (!p.hasAcceptanceCriteria) {
      parts.push({ em: 'Acceptance Criteria (ACs)', rest: 'must be created and verified' });
    } else if (p.unverifiedAcCount > 0) {
      const em =
        p.unverifiedAcCount === 1
          ? '1 Acceptance Criterion (AC)'
          : `${p.unverifiedAcCount} Acceptance Criteria (ACs)`;
      parts.push({ em, rest: 'must be verified' });
    }
  }
  // draft → plan and done have no rubric gate.
  return parts;
}

/** Render blocker parts, merging consecutive parts that share a requirement:
 * [Decisions|created] + [ACs|created] → "**Decisions** and **ACs** must be
 * created" (entities bold). Parts with different requirements join with "and". */
function renderBlockers(parts: BlockerPart[]) {
  const groups: { ems: string[]; rest: string }[] = [];
  for (const part of parts) {
    const last = groups[groups.length - 1];
    if (last && last.rest === part.rest) last.ems.push(part.em);
    else groups.push({ ems: [part.em], rest: part.rest });
  }
  return groups.map((g, gi) => (
    <span key={g.rest}>
      {gi > 0 && ' and '}
      {g.ems.map((em, ei) => (
        <span key={em}>
          {ei > 0 && ' and '}
          <strong className="font-semibold">{em}</strong>
        </span>
      ))}{' '}
      {g.rest}
    </span>
  ));
}

export function TransitionSentence({
  doc,
  currentPhase,
  viewedTab,
  canTransition = true,
  totalDecisionCount = 0,
  openDecisionCount = 0,
  hasAcceptanceCriteria = false,
  totalTaskCount = 0,
  openTaskCount = 0,
  unverifiedAcCount = 0,
  onTransitioned,
  onCancelBrowse,
}: TransitionSentenceProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The target phase the sentence is about. When the viewed tab is the current
  // phase's home, the offer is the standard forward step (draft's home is the
  // Plan tab → draft offers plan). Otherwise the offer targets the viewed tab's
  // own phase.
  const viewingCurrentTab =
    viewedTab === currentPhase ||
    // draft has no tab of its own — viewing the Plan tab while in draft is "current".
    (currentPhase === 'draft' && viewedTab === 'plan');

  const target: SpecStatus | null = viewingCurrentTab ? nextPhase(currentPhase) : viewedTab;
  const backward = target !== null && phaseOrder(target) < phaseOrder(currentPhase);

  const blockers = blockerFragments({
    currentPhase,
    totalDecisionCount,
    openDecisionCount,
    hasAcceptanceCriteria,
    totalTaskCount,
    openTaskCount,
    unverifiedAcCount,
  });

  async function handleYes() {
    if (!target) return;
    setSubmitting(true);
    setError(null);
    try {
      await updateDocStatus(doc.id, target);
      setSubmitting(false);
      onTransitioned?.(target);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update phase');
      setSubmitting(false);
    }
  }

  const yesButton = canTransition && (
    <Button type="button" size="sm" variant="primary" onClick={handleYes} disabled={submitting}>
      {submitting ? 'Moving…' : 'Yes'}
    </Button>
  );
  const noButton = canTransition && (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      onClick={() => onCancelBrowse?.()}
      disabled={submitting}
    >
      No
    </Button>
  );
  const errorNote = error && (
    <span className="ml-2 text-status-danger-text" role="alert">
      {error}
    </span>
  );

  // No target at all (e.g. done with nothing further) → nothing to say; the
  // tab bar already carries the phase (and `done` collapses the whole block
  // into the DoneSummary anyway).
  if (!target) {
    return null;
  }

  // Shape 1/2 — viewing the current phase's own tab.
  if (viewingCurrentTab) {
    if (blockers.length > 0) {
      // Blocked: state the exact rubric condition. The work is obvious — no
      // buttons to press.
      return (
        <p className="text-sm text-secondary" data-testid="transition-sentence">
          {renderBlockers(blockers)} before this spec can move to {target}.
        </p>
      );
    }
    // Ready: the advancement offer.
    const verb = target === 'verify' || target === 'done' ? 'Do you want' : 'Do you wish';
    return (
      <p className="text-sm text-secondary" data-testid="transition-sentence">
        {verb} to move this spec to {target}? {yesButton}
        {errorNote}
      </p>
    );
  }

  // Shape 3 — browsing another tab: an explicit confirm with [Yes] [No]; No
  // returns to the current tab. Forward+blocked leads with the blocker summary
  // (which already names the target) and asks "Move this spec anyway?" —
  // naming the target once, with the friction carried by "anyway".
  const showSummary = !backward && blockers.length > 0;
  const question = backward
    ? `Do you want to move this spec back to ${target}?`
    : showSummary
      ? 'Move this spec anyway?'
      : `Are you sure you want to move this spec to ${target}?`;
  return (
    <p className="text-sm text-secondary" data-testid="transition-sentence">
      {showSummary && <>{renderBlockers(blockers)} before {target}. </>}
      {question} {yesButton} {noButton}
      {errorNote}
    </p>
  );
}
