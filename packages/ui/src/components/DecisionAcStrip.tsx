// DecisionAcStrip — renders below each resolved Decision card on the
// Decisions tab. Shows the manager whether the Decision they spent
// attention on is actually being honoured by the codebase.
//
// The hypothesis Part I framing: "A resolved Decision tells you 'we chose
// Redis with TTL invalidation.' An AC tells you 'the system uses Redis
// with TTL, default 5 minutes' in a form a test can assert." This strip
// closes the loop by showing, per Decision, which ACs spawned from it and
// whether they're currently verified.
//
// Visual language is intentionally identical to the AC tab (same colour
// palette, same pill shape) so the manager learns the vocabulary once.
// Pills are non-clickable in V0.0.1 — a follow-up can add navigate-to-AC
// behaviour if the value is there.

import type { AcWithVerification } from '../api/client';
import { AcPill } from './AcPill';
// spec-566 dec-2 — one rendering decision for the superseded count.
import { isLiveAcStatus, coverageAnnotationLabels } from '@memex/shared';

interface DecisionAcStripProps {
  /** All ACs for the Spec — caller passes the unfiltered set, this
   *  component filters to the ACs whose parents include this decisionId. */
  acs: AcWithVerification[];
  decisionId: string;
  /** spec-566 dec-7 (ac-22) — done-gate overrides on the owning Spec. A
   *  Spec-level number the AC rows cannot carry, so the panel hands it down. */
  gateOverrides?: number;
  /** spec-566 dec-9 (t-8) — reopens on the owning Spec. */
  reopens?: number;
  /** Click on a pill → call this with the AC's id; caller switches to the
   *  AC tab and focuses the row. */
  onJumpToAc?: (acId: string) => void;
}

export function DecisionAcStrip({
  acs,
  decisionId,
  gateOverrides = 0,
  reopens = 0,
  onJumpToAc,
}: DecisionAcStripProps) {
  const own = acs.filter((r) =>
    r.parents.some((p) => p.kind === 'decision' && p.id === decisionId),
  );

  if (own.length === 0) {
    // Render nothing when there are no ACs linked to this Decision.
    // Rationale: many Decisions don't (and shouldn't) spawn enforceable
    // claims — naming, scope, process. Showing a "no ACs" line under every
    // such card produced too much visual noise on real Specs (most legacy
    // Decisions pre-date the AC primitive). The absence of a strip IS the
    // signal; cards that DO render one make clear what it is.
    return null;
  }

  // spec-566 dec-2 — the caption counts the LIVE criteria this Decision spawned
  // and names the retired ones. A Decision whose AC was superseded should read
  // as one honoured claim plus one retired one, not as two claims one of which
  // is silently untested forever.
  const live = own.filter((r) => isLiveAcStatus(r.ac.status));
  const annotations = coverageAnnotationLabels({
    superseded: own.filter((r) => r.ac.status === 'superseded').length,
    overrides: gateOverrides,
    reopens,
  });
  const supersededLabel = annotations.length ? annotations.join(' · ') : null;

  const verified = live.filter((r) => r.verificationState === 'verified');
  const failing = live.filter((r) => r.verificationState === 'failing');
  const untested = live.filter((r) => r.verificationState === 'untested');
  const stale = live.filter((r) => r.verificationState === 'stale');

  // Caption order intentionally puts the win first ("4 verified") even
  // when there are failures — mirrors the green-first principle from the
  // AC tab.
  const parts: string[] = [];
  parts.push(`${verified.length} verified`);
  if (failing.length > 0) parts.push(`${failing.length} failing`);
  if (untested.length > 0) parts.push(`${untested.length} untested`);
  if (stale.length > 0) parts.push(`${stale.length} stale`);
  if (supersededLabel) parts.push(...annotations);

  return (
    <div
      className="mt-2 flex items-center gap-2 flex-wrap"
      onClick={(e) => e.stopPropagation()}
    >
      <span data-testid="decision-ac-strip-caption" className="text-xs text-muted">
        {live.length} AC{live.length === 1 ? '' : 's'} · {parts.join(' · ')}
      </span>
      <div className="flex flex-wrap gap-1">
        {own.map((r) => (
          <AcPill
            key={r.ac.id}
            row={r}
            onClick={
              onJumpToAc ? () => onJumpToAc(r.ac.id) : undefined
            }
            clickHint="Click to open this AC in the AC tab."
          />
        ))}
      </div>
    </div>
  );
}
