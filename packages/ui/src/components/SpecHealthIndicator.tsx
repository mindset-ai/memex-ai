// SpecHealthIndicator — per-card AC-health visual treatment for the Specs
// board (b-66). Two layered signals so the card reads at every zoom level:
//
//   1. Horizontal progress strip along the bottom (4px) — the dominant signal,
//      a proportional breakdown of the active ACs. Full card width; its ends
//      curve with the card so the bottom edge reads as one clean bar.
//   2. Tiny coverage chip in the bottom-right — exact numbers.
//
// The left-border accent that earlier carried the scan-distance signal was
// removed (design review, Jun 2026): the bottom strip alone is the prominent
// health read, so the two-bars-meeting-at-the-corner mess is gone with it.
// NOTE: this supersedes b-66 dec-1 (three signals) and the "border is the
// alarm" half of b-66 dec-2 — the spec text needs revising to match.
//
// Reuses STATE_DOT / STATE_PILL / STATE_LABEL from AcPill.tsx — does NOT
// define a parallel state→colour mapping (b-66 ac-2).
//
// Strip palette: verified=green, failing=rose, and everything not yet backed
// by a passing test (stale + untested) reads as YELLOW (amber-400). There is
// deliberately NO grey on the strip (design review, Jun 2026): an untested AC
// is a real "needs a test" commitment, so it warns yellow rather than reading
// as dead/absent. This supersedes b-66 dec-3's zinc-300 untested segment.
//
// Failing-wins semantics (b-66 dec-2): any `failing > 0` still sizes the chip
// to the failing count ("1 failing", not "49/50 verified"). The strip carries
// the green/red proportion so the manager can read "1 of 50" without clicking
// in. The chip is now the alarm; the strip is the detail.
//
// Absence-of-signal rule (b-66 ac-4): when `health` is undefined or
// `totalActive === 0`, every sub-component returns null. The caller can render
// the card as-is. The absence of the treatment IS the signal that the Spec
// has no commitments yet — explicitly NOT a warning state.

import type { AcHealth } from '../api/types';

export type CardHealthState =
  | 'verified'
  | 'failing'
  | 'partial'
  | 'no-commitments';

export function deriveCardHealthState(health: AcHealth | undefined): CardHealthState {
  // Treat "no payload at all" the same as "no active ACs" — both mean the
  // card should render as today, with no border/chip/strip overlay. The
  // server omits the field entirely for some shapes (legacy responses,
  // requests that don't pass `?include=acHealth`); both collapse to the
  // calm default here.
  if (!health || health.totalActive === 0) return 'no-commitments';
  // Failing-wins: one failing AC paints the card red even if everything
  // else is green. The alarm semantic is load-bearing (b-66 dec-2).
  if (health.failing > 0) return 'failing';
  // All-verified requires the full set: no failing, no stale, no untested,
  // and verified covers totalActive. Anything less is amber.
  if (health.verified === health.totalActive) return 'verified';
  return 'partial';
}

// Chip palette. Mirrors AcPill's chipByState tones (bg-{colour}/10 +
// text-{colour}-700/dark:text-{colour}-400) so the chip on the card reads
// the same as a pill on the AC tab. Verified chip is intentionally muted —
// the chip's job is to label, not to celebrate.
const CHIP_BY_STATE: Record<Exclude<CardHealthState, 'no-commitments'>, string> = {
  verified: 'bg-green-500/10 text-green-700 dark:text-green-400',
  failing: 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
  partial: 'bg-amber-400/10 text-amber-700 dark:text-amber-400',
};

interface SpecHealthIndicatorProps {
  health: AcHealth | undefined;
}

/**
 * The bottom-right numeric chip. Reads "N verified" / "N failing" / "N/M
 * verified" per state. Returns null when there's no signal.
 *
 * Failing state shows the failing count explicitly (b-66 dec-2) — "1 failing"
 * not "49/50 verified" — because the alarm is what the manager needs to
 * read first.
 */
export function SpecHealthChip({ health }: SpecHealthIndicatorProps) {
  const state = deriveCardHealthState(health);
  if (state === 'no-commitments' || !health) return null;
  const label = (() => {
    if (state === 'failing') {
      return `${health.failing} failing`;
    }
    if (state === 'verified') {
      return `${health.verified}/${health.totalActive} verified`;
    }
    // partial: show the verified-over-total ratio. Matches the "N% verified
    // (of covered)" framing on the AC tab but compressed for a card chip.
    return `${health.verified}/${health.totalActive} verified`;
  })();
  return (
    <span
      data-testid="spec-health-chip"
      data-health-state={state}
      className={`inline-flex items-center rounded-sm px-1.5 py-0.5 text-[10px] font-mono tabular-nums ${CHIP_BY_STATE[state]}`}
    >
      {label}
    </span>
  );
}

/**
 * The bottom progress strip. 4px tall, full card width, divided into
 * proportional segments. Verified is green and failing is rose (AcPill's
 * colours); stale and untested both read YELLOW (amber-400) — anything not
 * yet backed by a passing test is one "needs a test" warning band, with no
 * grey on the strip (design review, Jun 2026; supersedes b-66 dec-3).
 *
 * Renders null when health is absent or totalActive is 0 — the absence-
 * of-signal rule (b-66 ac-4).
 */
export function SpecHealthStrip({ health }: SpecHealthIndicatorProps) {
  if (!health || health.totalActive === 0) return null;
  // Use totalActive as the denominator (not covered) — an untested AC
  // is a real commitment the manager should see, not a hidden one.
  const total = health.totalActive;
  // Percentages are rounded to whole numbers because sub-percent slivers
  // render as 0px and the segments shift; the rounding error is absorbed
  // by the dominant segment via the residual calculation below.
  const verifiedPct = Math.round((health.verified / total) * 100);
  const failingPct = Math.round((health.failing / total) * 100);
  const stalePct = Math.round((health.stale / total) * 100);
  // Residual goes to untested so the segments always sum to exactly 100%
  // regardless of rounding direction. Untested is the visual "rest" bucket
  // anyway, so the residual lands in the most-honest place.
  const untestedPct = Math.max(0, 100 - verifiedPct - failingPct - stalePct);
  return (
    <div
      data-testid="spec-health-strip"
      className="absolute inset-x-0 bottom-0 h-[4px] flex overflow-hidden rounded-b-md"
      aria-hidden="true"
    >
      {verifiedPct > 0 && (
        <div
          data-testid="spec-health-strip-verified"
          className="bg-green-500"
          style={{ width: `${verifiedPct}%` }}
        />
      )}
      {failingPct > 0 && (
        <div
          data-testid="spec-health-strip-failing"
          className="bg-rose-500"
          style={{ width: `${failingPct}%` }}
        />
      )}
      {stalePct > 0 && (
        <div
          data-testid="spec-health-strip-stale"
          className="bg-amber-400"
          style={{ width: `${stalePct}%` }}
        />
      )}
      {untestedPct > 0 && (
        <div
          data-testid="spec-health-strip-untested"
          className="bg-amber-400"
          style={{ width: `${untestedPct}%` }}
        />
      )}
    </div>
  );
}
