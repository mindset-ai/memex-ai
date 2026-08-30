// spec-520 dec-9 (ac-42) — a row whose emissions have all left the retention window shows
// its last known state instead of a blank strip.
//
// Measured on prod 2026-08-30, before any swap: 196,978 of 243,339 pairs had not run in
// three days. Under the time window t-12 introduces, four out of five rows would render an
// empty strip beneath a "Verified" badge — the badge reads test_event_latest, which
// retention never touches, and the strip reads the log. A blank strip asserts "no evidence";
// the truth is "the evidence aged out, and here is what it said".
//
// The carried-forward state is NOT an emission and must never reach the strip's time axis:
// it is months older than the window, so positioning it as a square would put it off the
// axis and claim a run that the log no longer holds.

import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { TestMatrix } from './TestMatrix';
import type { AcTestMatrixRow } from '../api/client';

const AC_CARRY = 'mindset-prod/memex-building-itself/specs/spec-520/acs/ac-42';

const NOW = new Date('2026-08-30T12:00:00Z').getTime();

function darkRow(id: string, status: 'pass' | 'fail'): AcTestMatrixRow {
  return {
    testIdentifier: id,
    emissions: [],
    carriedForward: { status, emittedAt: '2026-06-12T09:00:00.000Z' },
  };
}

function liveRow(id: string): AcTestMatrixRow {
  return {
    testIdentifier: id,
    emissions: [{ status: 'pass', emittedAt: '2026-08-30T11:00:00.000Z' }],
    carriedForward: null,
  };
}

describe('TestMatrix · carried-forward rows', () => {
  it('shows the last known state where the strip would otherwise be blank', () => {
    tagAc(AC_CARRY);
    render(<TestMatrix rows={[darkRow('a::t', 'pass')]} now={NOW} />);
    const strip = screen.getByTestId('test-matrix-strip');
    expect(strip.textContent).toMatch(/last known/i);
    // The date matters: "last known: passed" with no WHEN is nearly as misleading as a
    // blank strip. Computed here rather than hardcoded, so the assertion does not depend
    // on the runner's locale.
    const shown = new Date('2026-06-12T09:00:00.000Z').toLocaleDateString();
    expect(strip.textContent).toContain(shown);
    // …and hovering explains why the strip is empty, not just what it last said.
    expect(within(strip).getByTitle(/no retained emissions/i)).toBeInTheDocument();
  });

  it('does not place the carried-forward state on the time axis', () => {
    tagAc(AC_CARRY);
    const { container } = render(<TestMatrix rows={[darkRow('a::t', 'pass')]} now={NOW} />);
    // No emission square: a June point on an axis whose left edge is 30 days back would be
    // positioned off the strip, and it would assert a run inside the window.
    expect(container.querySelectorAll('[data-testid="emission-square"]')).toHaveLength(0);
  });

  it('carries a RED state forward as red', () => {
    tagAc(AC_CARRY);
    render(<TestMatrix rows={[darkRow('a::t', 'fail')]} now={NOW} />);
    const strip = screen.getByTestId('test-matrix-strip');
    // Carrying only greens forward would make the fallback a way of hiding failures.
    expect(strip.textContent).toMatch(/fail/i);
  });

  it('leaves a row that still has emissions completely alone', () => {
    tagAc(AC_CARRY);
    render(<TestMatrix rows={[liveRow('a::t')]} now={NOW} />);
    const strip = screen.getByTestId('test-matrix-strip');
    expect(strip.textContent).not.toMatch(/last known/i);
    expect(strip.querySelectorAll('[data-testid="emission-square"]').length).toBeGreaterThan(0);
  });
});
