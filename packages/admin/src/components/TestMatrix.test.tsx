// Tests for TestMatrix (b-96 t-3) + the time-axis refinement layered on top
// of the original spec: per-row cap, shared time axis, min spacing, and the
// "stopped" gap as a first-class signal. Each case tags the b-96 ACs it
// empirically asserts so the Spec's AC tab reflects coverage as we go.

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  TestMatrix,
  computeMatrixWindow,
  positionEmissions,
  selectVisibleEmissions,
} from './TestMatrix';
import type { AcTestMatrixRow } from '../api/client';
import { tagAc } from "@memex-ai-ac/vitest";

const B96 = 'mindset-prod/memex-building-itself/briefs/b-96';

// Frozen "now" used across the rendered-component tests so axis positioning
// is deterministic regardless of when the suite runs.
const NOW_ISO = '2026-05-29T12:00:00Z';
const NOW_MS = new Date(NOW_ISO).getTime();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function makeRow(
  testIdentifier: string,
  emissions: AcTestMatrixRow['emissions'],
): AcTestMatrixRow {
  return { testIdentifier, emissions };
}

describe('TestMatrix', () => {
  it('renders one row per test_identifier', () => {
    tagAc(`${B96}/acs/ac-1`);
    const rows = [
      makeRow('t_alpha', [{ status: 'pass', emittedAt: NOW_ISO }]),
      makeRow('t_beta', [{ status: 'fail', emittedAt: NOW_ISO }]),
      makeRow('t_gamma', [{ status: 'error', emittedAt: NOW_ISO }]),
    ];
    render(<TestMatrix rows={rows} now={NOW_MS} />);
    const rowEls = screen.getAllByTestId('test-matrix-row');
    expect(rowEls).toHaveLength(3);
    expect(rowEls[0].getAttribute('data-test-identifier')).toBe('t_alpha');
    expect(rowEls[1].getAttribute('data-test-identifier')).toBe('t_beta');
    expect(rowEls[2].getAttribute('data-test-identifier')).toBe('t_gamma');
  });

  it('renders one square per visible emission, preserving newest-first DOM order [ac-6]', () => {
    tagAc(`${B96}/acs/ac-6`);
    // Three emissions, all within the 24h window so all three are visible.
    // The component preserves the server's DESC order — newest first in the
    // DOM, which the time-axis pushes to the right via leftPx.
    const rows = [
      makeRow('t_alpha', [
        { status: 'pass', emittedAt: new Date(NOW_MS - 4 * HOUR).toISOString() },
        { status: 'fail', emittedAt: new Date(NOW_MS - 8 * HOUR).toISOString() },
        { status: 'pass', emittedAt: new Date(NOW_MS - 12 * HOUR).toISOString() },
      ]),
    ];
    const { container } = render(<TestMatrix rows={rows} now={NOW_MS} />);
    const squares = container.querySelectorAll('[data-status]');
    expect(squares).toHaveLength(3);
    expect(squares[0].getAttribute('data-status')).toBe('pass');
    expect(squares[1].getAttribute('data-status')).toBe('fail');
    expect(squares[2].getAttribute('data-status')).toBe('pass');
  });

  it('colours squares by status: pass=green, fail=rose, error=amber [ac-1]', () => {
    tagAc(`${B96}/acs/ac-1`);
    const rows = [
      makeRow('t_mix', [
        { status: 'pass', emittedAt: new Date(NOW_MS - 2 * HOUR).toISOString() },
        { status: 'fail', emittedAt: new Date(NOW_MS - 4 * HOUR).toISOString() },
        { status: 'error', emittedAt: new Date(NOW_MS - 6 * HOUR).toISOString() },
      ]),
    ];
    const { container } = render(<TestMatrix rows={rows} now={NOW_MS} />);
    const squares = container.querySelectorAll('[data-status]');
    expect(squares[0].className).toContain('bg-green-500');
    expect(squares[1].className).toContain('bg-rose-500');
    expect(squares[2].className).toContain('bg-amber-500');
  });

  it('renders an empty-state message when there are zero rows', () => {
    tagAc(`${B96}/acs/ac-1`);
    render(<TestMatrix rows={[]} now={NOW_MS} />);
    expect(
      screen.getByText(/no events recorded for this ac/i),
    ).toBeInTheDocument();
  });

  it('renders the (unnamed) placeholder for an empty test_identifier', () => {
    tagAc(`${B96}/acs/ac-1`);
    const rows = [makeRow('', [{ status: 'error', emittedAt: NOW_ISO }])];
    render(<TestMatrix rows={rows} now={NOW_MS} />);
    expect(screen.getByText(/\(unnamed\)/i)).toBeInTheDocument();
  });

  it('invokes renderRowAction for each row when provided', () => {
    tagAc(`${B96}/acs/ac-1`);
    const rows = [
      makeRow('t_a', [{ status: 'pass', emittedAt: NOW_ISO }]),
      makeRow('t_b', [{ status: 'pass', emittedAt: NOW_ISO }]),
    ];
    render(
      <TestMatrix
        rows={rows}
        now={NOW_MS}
        renderRowAction={(row) => (
          <button data-testid={`act-${row.testIdentifier}`}>x</button>
        )}
      />,
    );
    expect(screen.getByTestId('act-t_a')).toBeInTheDocument();
    expect(screen.getByTestId('act-t_b')).toBeInTheDocument();
  });

  it('emission squares carry a title with status and timestamp for hover tooltips', () => {
    tagAc(`${B96}/acs/ac-1`);
    const rows = [
      makeRow('t_alpha', [{ status: 'pass', emittedAt: NOW_ISO }]),
    ];
    const { container } = render(<TestMatrix rows={rows} now={NOW_MS} />);
    const square = container.querySelector('[data-status]') as HTMLElement;
    expect(square.title).toMatch(/pass/);
    expect(square.title.length).toBeGreaterThan('pass · '.length);
  });

  it('each square renders a visible-on-hover tooltip sibling carrying the timestamp', () => {
    tagAc(`${B96}/acs/ac-1`);
    const rows = [
      makeRow('t_alpha', [{ status: 'pass', emittedAt: NOW_ISO }]),
    ];
    const { container } = render(<TestMatrix rows={rows} now={NOW_MS} />);
    const square = container.querySelector('[data-status]') as HTMLElement;
    const tooltip = square.nextElementSibling as HTMLElement | null;
    expect(tooltip).not.toBeNull();
    expect(tooltip!.textContent).toBe(square.title);
    expect(tooltip!.className).toMatch(/opacity-0/);
    expect(tooltip!.className).toMatch(/group-hover\/sq:opacity-100/);
  });

  it('renders an axis row with the window start date and "today" anchored to the strip', () => {
    tagAc(`${B96}/acs/ac-1`);
    const rows = [
      makeRow('t_alpha', [{ status: 'pass', emittedAt: NOW_ISO }]),
    ];
    render(<TestMatrix rows={rows} now={NOW_MS} />);
    const axis = screen.getByTestId('test-matrix-axis');
    expect(axis.textContent).toMatch(/today/i);
    // Window start label is a locale date — assert its length is non-trivial
    // and not literally "today", which is enough to know SOMETHING rendered
    // on the left without locking the test to a specific locale.
    const labels = Array.from(axis.children) as HTMLElement[];
    expect(labels[0].textContent).not.toMatch(/today/i);
    expect(labels[0].textContent!.length).toBeGreaterThan(0);
  });
});

// ── Pure helpers — exercised directly so the rules are pinned independent
//    of the React render path. ─────────────────────────────────────────────

describe('selectVisibleEmissions (per-row cap)', () => {
  it('returns all emissions in the last 30 days when that count exceeds 10', () => {
    tagAc(`${B96}/acs/ac-6`);
    // 15 emissions, all within the last week — cap should NOT clip below 15.
    const emissions = Array.from({ length: 15 }, (_, i) => ({
      status: 'pass' as const,
      emittedAt: new Date(NOW_MS - i * HOUR).toISOString(),
    }));
    expect(selectVisibleEmissions(emissions, NOW_MS)).toHaveLength(15);
  });

  it('falls back to the most recent 10 when fewer than 10 emissions fall within the 30d window', () => {
    tagAc(`${B96}/acs/ac-6`);
    // 12 emissions, only 3 inside the 30d window — must still show 10
    // (the cap takes precedence when 30d count is small).
    const recent = Array.from({ length: 3 }, (_, i) => ({
      status: 'pass' as const,
      emittedAt: new Date(NOW_MS - i * DAY).toISOString(),
    }));
    const older = Array.from({ length: 9 }, (_, i) => ({
      status: 'pass' as const,
      emittedAt: new Date(NOW_MS - (40 + i) * DAY).toISOString(),
    }));
    const visible = selectVisibleEmissions([...recent, ...older], NOW_MS);
    expect(visible).toHaveLength(10);
    // Newest-first preserved; cap takes the first 10 (3 recent + 7 oldest of
    // the older bucket — i.e. emissions[0..9]).
    expect(visible[0].emittedAt).toBe(recent[0].emittedAt);
    expect(visible[9].emittedAt).toBe(older[6].emittedAt);
  });

  it('returns [] for an empty input', () => {
    tagAc(`${B96}/acs/ac-6`);
    expect(selectVisibleEmissions([], NOW_MS)).toEqual([]);
  });
});

describe('computeMatrixWindow', () => {
  it('right-anchors to now and defaults to a 30-day window when emissions are recent', () => {
    tagAc(`${B96}/acs/ac-1`);
    const rows = [
      makeRow('t', [{ status: 'pass', emittedAt: new Date(NOW_MS - 5 * HOUR).toISOString() }]),
    ];
    const w = computeMatrixWindow(rows, NOW_MS);
    expect(w.endMs).toBe(NOW_MS);
    expect(w.startMs).toBe(NOW_MS - 30 * DAY);
  });

  it('stretches the window when a visible emission is older than 30 days', () => {
    tagAc(`${B96}/acs/ac-1`);
    // Only 1 emission, 60 days old. The per-row cap rule keeps it visible
    // (1 < 10), so the matrix window must stretch back to fit it.
    const old = new Date(NOW_MS - 60 * DAY).toISOString();
    const rows = [makeRow('t', [{ status: 'pass', emittedAt: old }])];
    const w = computeMatrixWindow(rows, NOW_MS);
    expect(w.startMs).toBe(new Date(old).getTime());
  });

  it('always keeps the axis at least 24h wide and right-anchored to now', () => {
    tagAc(`${B96}/acs/ac-1`);
    // Three emissions clustered within 5 minutes of each other.
    const rows = [
      makeRow('t', [
        { status: 'pass', emittedAt: new Date(NOW_MS - 1 * 60_000).toISOString() },
        { status: 'pass', emittedAt: new Date(NOW_MS - 3 * 60_000).toISOString() },
        { status: 'pass', emittedAt: new Date(NOW_MS - 5 * 60_000).toISOString() },
      ]),
    ];
    const w = computeMatrixWindow(rows, NOW_MS);
    expect(w.endMs).toBe(NOW_MS);
    expect(w.endMs - w.startMs).toBeGreaterThanOrEqual(24 * HOUR);
  });
});

describe('positionEmissions', () => {
  const window = { startMs: NOW_MS - 30 * DAY, endMs: NOW_MS };
  const stripWidth = 300;
  const squareWidth = 12;
  const minGap = 4;

  it('positions the newest emission flush against the right edge', () => {
    tagAc(`${B96}/acs/ac-1`);
    const emissions = [
      { status: 'pass' as const, emittedAt: new Date(NOW_MS).toISOString() },
    ];
    const positioned = positionEmissions(emissions, window, stripWidth, squareWidth, minGap);
    // Right edge = stripWidth - squareWidth = 288.
    expect(positioned[0].leftPx).toBe(stripWidth - squareWidth);
  });

  it('leaves visible empty space to the right of an old final emission ("stopped" signal)', () => {
    tagAc(`${B96}/acs/ac-1`);
    // The test's last emission landed 15 days ago. The window is 30 days.
    // The square should sit roughly at the midpoint, leaving ~half the
    // strip empty to the right — the "stopped 15d ago" visual gap.
    const emissions = [
      {
        status: 'fail' as const,
        emittedAt: new Date(NOW_MS - 15 * DAY).toISOString(),
      },
    ];
    const positioned = positionEmissions(emissions, window, stripWidth, squareWidth, minGap);
    // 15/30 = 50% along the strip's usable width (stripWidth - squareWidth).
    const expected = 0.5 * (stripWidth - squareWidth);
    expect(positioned[0].leftPx).toBeCloseTo(expected, 0);
    // Not at the right edge — that's the whole point of this assertion.
    expect(positioned[0].leftPx).toBeLessThan(stripWidth - squareWidth);
  });

  it('enforces min spacing for emissions that would visually overlap', () => {
    tagAc(`${B96}/acs/ac-1`);
    // Three emissions within the same 1-minute window — natural positions
    // would all stack on the same right-edge pixel. Spacing rule must push
    // older ones leftward by (squareWidth + minGap) = 16px each.
    const emissions = [
      { status: 'pass' as const, emittedAt: new Date(NOW_MS).toISOString() },
      { status: 'pass' as const, emittedAt: new Date(NOW_MS - 10_000).toISOString() },
      { status: 'pass' as const, emittedAt: new Date(NOW_MS - 20_000).toISOString() },
    ];
    const positioned = positionEmissions(emissions, window, stripWidth, squareWidth, minGap);
    expect(positioned).toHaveLength(3);
    expect(positioned[0].leftPx - positioned[1].leftPx).toBeCloseTo(squareWidth + minGap, 5);
    expect(positioned[1].leftPx - positioned[2].leftPx).toBeCloseTo(squareWidth + minGap, 5);
  });

  it('drops emissions that would be pushed off the left edge by the spacing rule', () => {
    tagAc(`${B96}/acs/ac-1`);
    // 30 emissions all stamped "now": only `floor(stripWidth / (sq + gap)) + 1`
    // can fit before the spacing rule walks off the left edge.
    const emissions = Array.from({ length: 30 }, () => ({
      status: 'pass' as const,
      emittedAt: new Date(NOW_MS).toISOString(),
    }));
    const positioned = positionEmissions(emissions, window, stripWidth, squareWidth, minGap);
    // We DON'T pin the exact integer (off-by-one ambiguity around the left
    // edge); we just pin that the dense cluster is bounded well below the
    // input length AND that everything fits within [0, maxLeft].
    expect(positioned.length).toBeLessThan(emissions.length);
    expect(positioned.length).toBeGreaterThan(0);
    for (const p of positioned) {
      expect(p.leftPx).toBeGreaterThanOrEqual(0);
      expect(p.leftPx).toBeLessThanOrEqual(stripWidth - squareWidth);
    }
  });

  it('returns [] for an empty input', () => {
    tagAc(`${B96}/acs/ac-1`);
    expect(positionEmissions([], window)).toEqual([]);
  });
});

// spec-115 v0.1.0 ac-3: emission metadata is surfaced in the AC matrix
// tooltip. Well-known keys (actor, branch, commit, host, run_id, run_url)
// render first in a documented order; unknown customer-defined keys render
// after as plain key: value pairs.
const AC115 = 'mindset-prod/memex-building-itself/specs/spec-115/acs';

describe('TestMatrix — emission metadata in tooltip', () => {
  it('surfaces well-known metadata keys in the tooltip [spec-115 ac-3]', () => {
    tagAc(`${AC115}/ac-3`);
    const rows = [
      makeRow('t_alpha', [
        {
          status: 'pass',
          emittedAt: NOW_ISO,
          metadata: {
            actor: 'wic',
            branch: 'main',
            commit: 'abc1234567',
            host: 'ci',
          },
        },
      ]),
    ];
    render(<TestMatrix rows={rows} now={NOW_MS} />);
    const tooltip = screen.getByTestId('emission-metadata');
    expect(tooltip.querySelector('[data-metadata-key="actor"]')).not.toBeNull();
    expect(tooltip.querySelector('[data-metadata-key="branch"]')).not.toBeNull();
    expect(tooltip.querySelector('[data-metadata-key="commit"]')).not.toBeNull();
    expect(tooltip.querySelector('[data-metadata-key="host"]')).not.toBeNull();
    expect(tooltip.textContent).toContain('actor');
    expect(tooltip.textContent).toContain('wic');
    expect(tooltip.textContent).toContain('main');
  });

  it('truncates commit hash to 7 chars in the tooltip [spec-115 ac-3]', () => {
    tagAc(`${AC115}/ac-3`);
    const rows = [
      makeRow('t_alpha', [
        {
          status: 'pass',
          emittedAt: NOW_ISO,
          metadata: { commit: 'abc1234567890def' },
        },
      ]),
    ];
    render(<TestMatrix rows={rows} now={NOW_MS} />);
    const commitNode = screen
      .getByTestId('emission-metadata')
      .querySelector('[data-metadata-key="commit"]');
    expect(commitNode?.textContent).toContain('abc1234');
    expect(commitNode?.textContent).not.toContain('abc1234567890def');
  });

  it('surfaces unknown customer-defined keys after well-known ones [spec-115 ac-3]', () => {
    tagAc(`${AC115}/ac-3`);
    const rows = [
      makeRow('t_alpha', [
        {
          status: 'pass',
          emittedAt: NOW_ISO,
          metadata: {
            actor: 'wic',
            tenant: 'acme',
            feature_flag: 'rag_v2',
          },
        },
      ]),
    ];
    render(<TestMatrix rows={rows} now={NOW_MS} />);
    const tooltip = screen.getByTestId('emission-metadata');
    expect(tooltip.querySelector('[data-metadata-key="actor"]')).not.toBeNull();
    expect(tooltip.querySelector('[data-metadata-key="tenant"]')).not.toBeNull();
    expect(tooltip.querySelector('[data-metadata-key="feature_flag"]')).not.toBeNull();
  });

  it('renders the title attribute with metadata for accessibility [spec-115 ac-3]', () => {
    tagAc(`${AC115}/ac-3`);
    const rows = [
      makeRow('t_alpha', [
        {
          status: 'pass',
          emittedAt: NOW_ISO,
          metadata: { actor: 'wic', branch: 'main' },
        },
      ]),
    ];
    const { container } = render(<TestMatrix rows={rows} now={NOW_MS} />);
    const square = container.querySelector('[data-status="pass"]');
    expect(square?.getAttribute('title')).toContain('actor: wic');
    expect(square?.getAttribute('title')).toContain('branch: main');
  });

  it('does not render a metadata tooltip section when metadata is null', () => {
    const rows = [
      makeRow('t_alpha', [
        { status: 'pass', emittedAt: NOW_ISO, metadata: null },
      ]),
    ];
    render(<TestMatrix rows={rows} now={NOW_MS} />);
    expect(screen.queryByTestId('emission-metadata')).toBeNull();
  });

  it('caps the visible metadata at MAX_TOOLTIP_KEYS with "+N more"', () => {
    const manyKeys: Record<string, string> = {};
    for (let i = 0; i < 20; i++) {
      manyKeys[`key_${String(i).padStart(2, '0')}`] = `v${i}`;
    }
    const rows = [
      makeRow('t_alpha', [
        { status: 'pass', emittedAt: NOW_ISO, metadata: manyKeys },
      ]),
    ];
    render(<TestMatrix rows={rows} now={NOW_MS} />);
    const tooltip = screen.getByTestId('emission-metadata');
    expect(tooltip.textContent).toContain('more');
  });
});

// spec-115 dec-6: actor is rendered from the top-level emission field, not
// from metadata.actor. The tooltip surfaces it in its own slot just below
// status/timestamp.
describe('TestMatrix — top-level actor in tooltip (spec-115 dec-6)', () => {
  it('renders actor from the top-level emission field [spec-115 dec-6 ac-30]', () => {
    tagAc(`${AC115}/ac-30`);
    const rows = [
      makeRow('t_alpha', [
        { status: 'pass', emittedAt: NOW_ISO, actor: 'wic' },
      ]),
    ];
    render(<TestMatrix rows={rows} now={NOW_MS} />);
    const actorSlot = screen.getByTestId('emission-actor');
    expect(actorSlot.textContent).toContain('actor');
    expect(actorSlot.textContent).toContain('wic');
  });

  it('does not render the actor slot when the top-level actor is null [spec-115 dec-6 ac-30]', () => {
    tagAc(`${AC115}/ac-30`);
    const rows = [
      makeRow('t_alpha', [
        { status: 'pass', emittedAt: NOW_ISO, actor: null },
      ]),
    ];
    render(<TestMatrix rows={rows} now={NOW_MS} />);
    expect(screen.queryByTestId('emission-actor')).toBeNull();
  });

  it('does NOT promote metadata.actor into the top-level actor slot [spec-115 dec-6 ac-30]', () => {
    tagAc(`${AC115}/ac-30`);
    // Hand-rolled emission shape: actor only in metadata, top-level is null.
    // The UI surfaces only the top-level field; metadata.actor renders (if
    // at all) as a plain metadata key, not in the actor slot.
    const rows = [
      makeRow('t_alpha', [
        {
          status: 'pass',
          emittedAt: NOW_ISO,
          actor: null,
          metadata: { actor: 'from-metadata' },
        },
      ]),
    ];
    render(<TestMatrix rows={rows} now={NOW_MS} />);
    expect(screen.queryByTestId('emission-actor')).toBeNull();
  });

  it('includes actor in the accessibility title attribute [spec-115 dec-6 ac-30]', () => {
    tagAc(`${AC115}/ac-30`);
    const rows = [
      makeRow('t_alpha', [
        { status: 'pass', emittedAt: NOW_ISO, actor: 'wic' },
      ]),
    ];
    const { container } = render(<TestMatrix rows={rows} now={NOW_MS} />);
    const square = container.querySelector('[data-status="pass"]');
    expect(square?.getAttribute('title')).toContain('actor: wic');
  });
});
