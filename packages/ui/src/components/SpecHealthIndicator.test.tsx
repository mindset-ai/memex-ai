// Tests for the SpecHealthIndicator (b-66 t-1). Each test tags the
// Scope ACs on b-66 it empirically asserts, so the board treatment shows
// up as verified on the Spec's AC tab.

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  SpecHealthChip,
  SpecHealthStrip,
  deriveCardHealthState,
} from './SpecHealthIndicator';
import { tagAc } from "@memex-ai-ac/vitest";
import type { AcHealth } from '../api/types';

const B66 = 'mindset-int/memex-app/specs/spec-66';

function makeHealth(overrides: Partial<AcHealth> = {}): AcHealth {
  return {
    totalActive: 0,
    covered: 0,
    verified: 0,
    failing: 0,
    stale: 0,
    untested: 0,
    ...overrides,
  };
}

describe('deriveCardHealthState', () => {
  it('returns no-commitments when health is undefined', () => {
    tagAc(`${B66}/acs/ac-4`);
    expect(deriveCardHealthState(undefined)).toBe('no-commitments');
  });

  it('returns no-commitments when totalActive is 0', () => {
    tagAc(`${B66}/acs/ac-4`);
    expect(deriveCardHealthState(makeHealth({ totalActive: 0 }))).toBe('no-commitments');
  });

  it('returns failing when any AC is failing, even if 49/50 are verified (failing-wins)', () => {
    // b-66 dec-2: one failing AC out of fifty still paints the card red.
    // The alarm semantic is load-bearing.
    tagAc(`${B66}/acs/ac-1`);
    expect(
      deriveCardHealthState(makeHealth({ totalActive: 50, verified: 49, failing: 1 })),
    ).toBe('failing');
  });

  it('returns verified only when verified covers totalActive with no failing/stale/untested', () => {
    tagAc(`${B66}/acs/ac-1`);
    expect(
      deriveCardHealthState(makeHealth({ totalActive: 5, verified: 5 })),
    ).toBe('verified');
  });

  it('returns partial when verified < totalActive and nothing is failing', () => {
    // b-66 dec-3: stale + untested collapse into card-level amber. The
    // strip carries the four-way split.
    tagAc(`${B66}/acs/ac-1`);
    expect(
      deriveCardHealthState(makeHealth({ totalActive: 5, verified: 3, untested: 2 })),
    ).toBe('partial');
    expect(
      deriveCardHealthState(makeHealth({ totalActive: 5, verified: 3, stale: 2 })),
    ).toBe('partial');
  });
});

describe('SpecHealthChip', () => {
  it('renders nothing when there are no commitments', () => {
    // b-66 ac-4
    tagAc(`${B66}/acs/ac-4`);
    const { container } = render(<SpecHealthChip health={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the failing count on a failing card (not the verified ratio)', () => {
    // b-66 dec-2: "1 failing", not "49/50 verified". The alarm is what
    // the manager needs to read first.
    tagAc(`${B66}/acs/ac-1`);
    render(<SpecHealthChip health={makeHealth({ totalActive: 50, verified: 49, failing: 1 })} />);
    const chip = screen.getByTestId('spec-health-chip');
    expect(chip).toHaveTextContent('1 failing');
    expect(chip).toHaveAttribute('data-health-state', 'failing');
  });

  it('shows the verified ratio on a fully-verified card', () => {
    tagAc(`${B66}/acs/ac-1`);
    render(<SpecHealthChip health={makeHealth({ totalActive: 6, verified: 6 })} />);
    const chip = screen.getByTestId('spec-health-chip');
    expect(chip).toHaveTextContent('6/6 verified');
    expect(chip).toHaveAttribute('data-health-state', 'verified');
  });

  it('shows the verified ratio on a partial card', () => {
    tagAc(`${B66}/acs/ac-1`);
    render(<SpecHealthChip health={makeHealth({ totalActive: 5, verified: 3, untested: 2 })} />);
    const chip = screen.getByTestId('spec-health-chip');
    expect(chip).toHaveTextContent('3/5 verified');
    expect(chip).toHaveAttribute('data-health-state', 'partial');
  });
});

describe('SpecHealthStrip', () => {
  it('renders nothing when totalActive is 0 (absence-of-signal)', () => {
    // b-66 ac-4
    tagAc(`${B66}/acs/ac-4`);
    const { container } = render(<SpecHealthStrip health={undefined} />);
    expect(container).toBeEmptyDOMElement();
    const { container: c2 } = render(
      <SpecHealthStrip health={makeHealth({ totalActive: 0 })} />,
    );
    expect(c2).toBeEmptyDOMElement();
  });

  it('reuses AcPill colours for verified/failing; stale + untested both read yellow', () => {
    // b-66 ac-2: verified/failing keep AcPill's green-500/rose-500. Stale and
    // untested both render amber-400 (yellow) — design review (Jun 2026)
    // removed grey from the strip so anything not backed by a passing test
    // reads as one "needs a test" warning band. Supersedes b-66 dec-3's
    // zinc-300 untested segment.
    tagAc(`${B66}/acs/ac-2`);
    render(
      <SpecHealthStrip
        health={makeHealth({
          totalActive: 10,
          verified: 4,
          failing: 2,
          stale: 2,
          untested: 2,
        })}
      />,
    );
    expect(screen.getByTestId('spec-health-strip-verified')).toHaveClass('bg-green-500');
    expect(screen.getByTestId('spec-health-strip-failing')).toHaveClass('bg-rose-500');
    expect(screen.getByTestId('spec-health-strip-stale')).toHaveClass('bg-amber-400');
    expect(screen.getByTestId('spec-health-strip-untested')).toHaveClass('bg-amber-400');
    // No grey anywhere on the strip — the affront the design review removed.
    expect(screen.getByTestId('spec-health-strip-untested')).not.toHaveClass('bg-zinc-300');
  });

  it('is 4px tall — the dominant, prominent health signal (left border removed)', () => {
    // Design review (Jun 2026): the bottom strip is now the sole AC-health
    // bar (the left-border accent was dropped), bumped 2px -> 4px so it reads
    // as something you're meant to look at.
    tagAc(`${B66}/acs/ac-2`);
    render(<SpecHealthStrip health={makeHealth({ totalActive: 4, verified: 4 })} />);
    expect(screen.getByTestId('spec-health-strip')).toHaveClass('h-[4px]');
  });

  it('shows the green/red proportion on a failing card (strip is the detail)', () => {
    // b-66 dec-2: failing-wins on the border, but the strip still carries
    // the green/red proportion so the manager can read "1 of 50".
    tagAc(`${B66}/acs/ac-1`);
    render(
      <SpecHealthStrip
        health={makeHealth({ totalActive: 50, verified: 49, failing: 1 })}
      />,
    );
    const greenSeg = screen.getByTestId('spec-health-strip-verified');
    const redSeg = screen.getByTestId('spec-health-strip-failing');
    // The exact percentages depend on the rounding rule (49/50 = 98%, 1/50 = 2%).
    // Assert both segments exist and the green dominates, regardless of
    // single-percentage drift.
    expect(greenSeg).toHaveStyle({ width: '98%' });
    expect(redSeg).toHaveStyle({ width: '2%' });
  });

  it('segments always sum to exactly 100% regardless of rounding (residual → untested)', () => {
    // Mixed health that produces fractional percentages — verifies the
    // residual-to-untested rounding rule (no missing pixels at the edge
    // of the card).
    tagAc(`${B66}/acs/ac-1`);
    render(
      <SpecHealthStrip
        health={makeHealth({ totalActive: 7, verified: 2, failing: 2, stale: 2, untested: 1 })}
      />,
    );
    const widths = [
      screen.getByTestId('spec-health-strip-verified'),
      screen.getByTestId('spec-health-strip-failing'),
      screen.getByTestId('spec-health-strip-stale'),
      screen.getByTestId('spec-health-strip-untested'),
    ].map((el) => parseInt((el as HTMLElement).style.width, 10));
    const total = widths.reduce((a, b) => a + b, 0);
    expect(total).toBe(100);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Decision-bound implementation ACs (b-66 ac-6, ac-7, ac-8).
//
// Each describe block asserts the concrete mechanism committed by one of the
// b-66 resolved decisions. Tagging the implementation AC ties the test back
// to the decision so the AC tab can show, per-decision, whether the
// resolution has a verifying test in the codebase.
// ──────────────────────────────────────────────────────────────────────────

describe('dec-1 (strip + chip) — both signals render together', () => {
  // SUPERSEDES b-66 dec-1's Option 5 (border + strip + chip). The left-border
  // accent was removed in the Jun 2026 design review; the card now carries
  // two signals — the 4px bottom strip (breakdown) and the chip (number).
  // Spec text needs revising to match.
  it('renders both signals when health is present with totalActive > 0', () => {
    tagAc(`${B66}/acs/ac-6`);
    const health = makeHealth({ totalActive: 4, verified: 4 });

    // Strip signal.
    const stripRender = render(<SpecHealthStrip health={health} />);
    expect(stripRender.queryByTestId('spec-health-strip')).not.toBeNull();
    stripRender.unmount();

    // Chip signal.
    const chipRender = render(<SpecHealthChip health={health} />);
    expect(chipRender.queryByTestId('spec-health-chip')).not.toBeNull();
    chipRender.unmount();
  });

  it('neither signal renders when there are no commitments', () => {
    // Inverse case: a no-commitments Spec must not show the strip or the chip
    // (b-66 Scope AC-4 — absence-of-signal).
    tagAc(`${B66}/acs/ac-6`);
    const stripRender = render(<SpecHealthStrip health={undefined} />);
    expect(stripRender.container).toBeEmptyDOMElement();
    stripRender.unmount();

    const chipRender = render(<SpecHealthChip health={undefined} />);
    expect(chipRender.container).toBeEmptyDOMElement();
    chipRender.unmount();
  });
});

describe('dec-2 (failing-wins, not proportional) — one failing AC is the alarm', () => {
  // SUPERSEDES the "border is the alarm" half of b-66 dec-2: with the left
  // border gone, the chip carries the alarm and the strip keeps the detail.
  it('sizes the chip to "N failing" AND keeps the strip green/red proportional', () => {
    tagAc(`${B66}/acs/ac-7`);
    const health = makeHealth({ totalActive: 50, verified: 49, failing: 1 });

    // 1. Chip → "1 failing", not "49/50 verified" (the alarm)
    const chipRender = render(<SpecHealthChip health={health} />);
    const chip = chipRender.getByTestId('spec-health-chip');
    expect(chip).toHaveTextContent('1 failing');
    expect(chip).not.toHaveTextContent('49/50 verified');
    expect(chip).toHaveAttribute('data-health-state', 'failing');
    chipRender.unmount();

    // 2. Strip → green dominates, red sliver visible (the detail)
    const stripRender = render(<SpecHealthStrip health={health} />);
    const green = stripRender.getByTestId('spec-health-strip-verified');
    const red = stripRender.getByTestId('spec-health-strip-failing');
    expect(green).toHaveStyle({ width: '98%' });
    expect(red).toHaveStyle({ width: '2%' });
    stripRender.unmount();
  });

  it('does not promote the chip to failing when failing is 0 (alarm is bound to failing, not partial)', () => {
    // Inverse case: a partial card (untested or stale, no failing) does NOT
    // get the failing alarm. It's specifically tied to failing > 0, not to
    // "anything less than fully verified".
    tagAc(`${B66}/acs/ac-7`);
    const partial = makeHealth({ totalActive: 5, verified: 3, untested: 2 });
    expect(deriveCardHealthState(partial)).toBe('partial');
    const chipRender = render(<SpecHealthChip health={partial} />);
    expect(chipRender.getByTestId('spec-health-chip')).toHaveAttribute('data-health-state', 'partial');
    chipRender.unmount();
  });
});

describe('dec-3 (amber-collapse) — card-level palette has four states; strip is verified/failing/yellow', () => {
  it('stale-only and untested-only Specs render the same card-level state (both → partial)', () => {
    // dec-3: stale and untested collapse into one card-level amber state.
    // The promise is that a manager scanning the board only learns four
    // colours — not five.
    tagAc(`${B66}/acs/ac-8`);
    const allStale = makeHealth({ totalActive: 3, verified: 0, stale: 3 });
    const allUntested = makeHealth({ totalActive: 3, verified: 0, untested: 3 });
    expect(deriveCardHealthState(allStale)).toBe('partial');
    expect(deriveCardHealthState(allUntested)).toBe('partial');
    // And they produce the same card-level state — not just by coincidence.
    expect(deriveCardHealthState(allStale)).toBe(deriveCardHealthState(allUntested));
  });

  it('strip renders stale AND untested both as yellow (no grey — supersedes dec-3 zinc split)', () => {
    // The Jun 2026 design review removed grey from the strip: stale and
    // untested now share amber-400 so the bottom bar never reads as dead.
    // This deliberately collapses dec-3's stale≠untested strip distinction.
    tagAc(`${B66}/acs/ac-8`);
    render(
      <SpecHealthStrip
        health={makeHealth({ totalActive: 4, verified: 0, stale: 2, untested: 2 })}
      />,
    );
    expect(screen.getByTestId('spec-health-strip-stale')).toHaveClass('bg-amber-400');
    expect(screen.getByTestId('spec-health-strip-untested')).toHaveClass('bg-amber-400');
    expect(screen.getByTestId('spec-health-strip-untested')).not.toHaveClass('bg-zinc-300');
  });

  it('the card-level palette has exactly four named states, no fifth', () => {
    // Structural assertion against `CardHealthState`. If a contributor adds
    // a new card-level state (e.g. 'stale-only' as a separate colour) they
    // need to either update dec-3 or update this test — either path forces
    // the conversation back to the resolution.
    tagAc(`${B66}/acs/ac-8`);
    const states = new Set<string>();
    states.add(deriveCardHealthState(undefined));
    states.add(deriveCardHealthState(makeHealth({ totalActive: 0 })));
    states.add(deriveCardHealthState(makeHealth({ totalActive: 5, verified: 5 })));
    states.add(deriveCardHealthState(makeHealth({ totalActive: 5, verified: 3, failing: 2 })));
    states.add(deriveCardHealthState(makeHealth({ totalActive: 5, verified: 3, untested: 2 })));
    states.add(deriveCardHealthState(makeHealth({ totalActive: 5, verified: 3, stale: 2 })));
    expect(states).toEqual(new Set(['no-commitments', 'verified', 'failing', 'partial']));
  });
});
