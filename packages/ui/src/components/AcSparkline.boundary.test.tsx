// spec-520 ac-40 — the alignment sparkline declares where its history actually begins.
//
// The per-day rollup ships mid-history. Every day before its first row is a day we CANNOT
// measure: the per-day past was destroyed by retention and cannot be reconstructed. The
// server marks those days `measured: false`.
//
// Drawing them as a flat 0% line would be the exact misreading ac-5 forbids — a deleted
// past rendering as a measured absence of green, which reads as "this Spec was red for a
// month" when the truth is "we were not counting yet". So: no line over unmeasured days,
// a visibly distinct band, and a note that names the first day we can actually vouch for.
//
// The span shrinks on its own as history accumulates and eventually disappears, so this is
// a treatment that retires itself rather than a permanent caveat.

import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { render, screen } from '@testing-library/react';
import { AcSparkline } from './AcSparkline';
import type { AcAlignmentDay } from '../api/client';

const AC_BOUNDARY =
  'mindset-prod/memex-building-itself/specs/spec-520/acs/ac-40';

function day(
  date: string,
  verified: number,
  total: number,
  measured: boolean,
): AcAlignmentDay {
  return { date, kind: 'scope', verified, total, measured };
}

/** Count the drawn vertices — `M` plus one per `L`. */
function vertexCount(container: HTMLElement): number {
  const d = container.querySelector('path')?.getAttribute('d') ?? '';
  if (!d) return 0;
  return (d.match(/[ML]/g) ?? []).length;
}

describe('AcSparkline · unmeasured history', () => {
  it('draws no line across days the rollup cannot vouch for', () => {
    tagAc(AC_BOUNDARY);
    const { container } = render(
      <AcSparkline
        data={[
          day('2026-08-24', 0, 2, false),
          day('2026-08-25', 0, 2, false),
          day('2026-08-26', 1, 2, true),
          day('2026-08-27', 2, 2, true),
          day('2026-08-28', 2, 2, true),
        ]}
      />,
    );
    // Three measured days → three vertices. A line drawn over all five would put the
    // curve at 0% for two days nobody measured.
    expect(vertexCount(container)).toBe(3);
  });

  it('names the first day it can vouch for', () => {
    tagAc(AC_BOUNDARY);
    render(
      <AcSparkline
        data={[
          day('2026-08-24', 0, 2, false),
          day('2026-08-27', 2, 2, true),
        ]}
      />,
    );
    expect(screen.getByText(/no history before 2026-08-27/i)).toBeInTheDocument();
  });

  it('says nothing when every day is measured', () => {
    tagAc(AC_BOUNDARY);
    render(
      <AcSparkline
        data={[
          day('2026-08-27', 1, 2, true),
          day('2026-08-28', 2, 2, true),
        ]}
      />,
    );
    // The note must retire itself once history covers the window, or it becomes furniture
    // that everyone learns to ignore.
    expect(screen.queryByText(/no history before/i)).not.toBeInTheDocument();
  });

  it('treats a response with no `measured` field as measured', () => {
    tagAc(AC_BOUNDARY);
    // Backward compatibility with a server that predates the flag: the absence of the
    // field must not paint the whole chart as unmeasured.
    const legacy = [
      { date: '2026-08-27', kind: 'scope', verified: 1, total: 2 },
      { date: '2026-08-28', kind: 'scope', verified: 2, total: 2 },
    ] as unknown as AcAlignmentDay[];
    const { container } = render(<AcSparkline data={legacy} />);
    expect(vertexCount(container)).toBe(2);
    expect(screen.queryByText(/no history before/i)).not.toBeInTheDocument();
  });

  it('reports the whole window as unmeasured rather than as a flat zero', () => {
    tagAc(AC_BOUNDARY);
    const { container } = render(
      <AcSparkline
        data={[
          day('2026-08-27', 0, 2, false),
          day('2026-08-28', 0, 2, false),
        ]}
      />,
    );
    // A brand-new Memex, or any tenant on the day the rollup ships. A flat 0% line here
    // would be the strongest form of the same lie.
    expect(vertexCount(container)).toBe(0);
    expect(screen.getByText(/no alignment history yet/i)).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The wiring that decides whether any of the above reaches a user.
// ─────────────────────────────────────────────────────────────────────────
//
// The panel merges the server's per-(date, kind) rows into one curve before handing them
// to the sparkline. That merge is the ONLY path into the chart, so a merge that drops
// `measured` leaves every assertion above passing while the real screen still draws a flat
// zero line across a month nobody measured.

describe('AcPanel · the kind-merge preserves the boundary flag', () => {
  it('keeps a day unmeasured through the merge of both kinds', async () => {
    tagAc(AC_BOUNDARY);
    const { mergeAlignmentHistory } = await import('./AcPanel');
    const merged = mergeAlignmentHistory([
      { date: '2026-08-24', kind: 'scope', verified: 0, total: 1, measured: false },
      { date: '2026-08-24', kind: 'implementation', verified: 0, total: 2, measured: false },
      { date: '2026-08-25', kind: 'scope', verified: 1, total: 1, measured: true },
      { date: '2026-08-25', kind: 'implementation', verified: 2, total: 2, measured: true },
    ]);
    expect(merged.map((d) => [d.date, d.total, d.measured])).toEqual([
      ['2026-08-24', 3, false],
      ['2026-08-25', 3, true],
    ]);
  });
});
