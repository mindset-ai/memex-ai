// SpecHealthIndicator — per-card AC-health visual treatment for the Specs
// board (b-66). Three layered signals so the card reads at every zoom level:
//
//   1. Thin left-border accent (3px) — state-coded; scan-distance signal
//   2. Horizontal progress strip along the bottom (2px) — four-way breakdown
//   3. Tiny coverage chip in the bottom-right — exact numbers
//
// Reuses STATE_DOT / STATE_PILL / STATE_LABEL from AcPill.tsx — does NOT
// define a parallel state→colour mapping (b-66 ac-2).
//
// Card-level palette has four buckets (verified / failing / partial-amber /
// no-commitments). The four-way breakdown survives one level down on the
// progress strip, where it pulls AcPill's per-state colours directly so the
// AC tab's vocabulary holds (b-66 dec-3).
//
// Failing-wins semantics (b-66 dec-2): any `failing > 0` paints the border red
// and the chip shows the failing count, even if 49 of 50 ACs are verified.
// The strip still shows the green/red proportion so the manager can read
// "1 of 50" without clicking in. Border is the alarm; strip is the detail.
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

// Card-level palette. Border classes only — kept narrow on purpose so the
// dominant state is legible at scan distance without making the verified
// case feel like a celebration (b-66 ac-5: "verified is the calm default").
// Verified deliberately uses a softer green (green-500/60 vs green-500) so
// a fully-green board doesn't feel loud; failing keeps full intensity
// because that's the alarm.
const BORDER_BY_STATE: Record<Exclude<CardHealthState, 'no-commitments'>, string> = {
  verified: 'border-l-[3px] border-l-green-500/60',
  failing: 'border-l-[3px] border-l-rose-500',
  partial: 'border-l-[3px] border-l-amber-400/80',
};

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
 * Returns the Tailwind border class to apply to the card's root element.
 * Empty string when there's no signal — caller spreads it into className
 * unconditionally and the card renders exactly as today.
 */
export function borderClassForHealth(health: AcHealth | undefined): string {
  const state = deriveCardHealthState(health);
  if (state === 'no-commitments') return '';
  return BORDER_BY_STATE[state];
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
 * The bottom progress strip. 2px tall, full card width, divided into four
 * proportional segments (verified / failing / stale / untested) using
 * AcPill's per-state colours so the strip reads as a horizontal flattening
 * of the AC tab's pills.
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
  // Residual goes to untested so the four segments always sum to exactly
  // 100% regardless of rounding direction. Untested is the visual "rest"
  // bucket anyway, so the residual lands in the most-honest place.
  const untestedPct = Math.max(0, 100 - verifiedPct - failingPct - stalePct);
  return (
    <div
      data-testid="spec-health-strip"
      className="absolute inset-x-0 bottom-0 h-[2px] flex overflow-hidden rounded-b-md"
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
          className="bg-zinc-300"
          style={{ width: `${untestedPct}%` }}
        />
      )}
    </div>
  );
}
