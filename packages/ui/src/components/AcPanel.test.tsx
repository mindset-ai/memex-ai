// Tests for AcPanel — the unified view that replaced the scope/implementation
// split. Pins the load-bearing properties of the new layout:
//
//   • One unified metric band, not two (covered + verified computed across
//     ALL ACs, scope + implementation merged).
//   • One sparkline, not two (alignment history summed by date across kinds).
//   • One flat list, sorted failing → stale → untested → verified.
//   • Each AC card retains a small kind badge (scope / impl) as a soft
//     affordance during the transition.
//
// The fetcher + useChat are stubbed so the test exercises the panel in
// isolation: no real network, no ChatProvider wrapping required.

import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AcPanel, buildVerifiedSegments } from './AcPanel';
import {
  fetchAcsForBrief,
  fetchAcAlignmentHistory,
  type AcWithVerification,
  type AcVerificationState,
  type AcAlignmentDay,
} from '../api/client';
import { tagAc } from "@memex-ai-ac/vitest";

// b-96 traceability — the unified header + delete flow it surfaces are ac-1.
const B96 = 'mindset-prod/memex-building-itself/briefs/b-96';

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>(
    '../api/client',
  );
  return {
    ...actual,
    fetchAcsForBrief: vi.fn(),
    fetchAcAlignmentHistory: vi.fn(),
    // The matrix collapsible fetches its own data lazily — mock here so a
    // click that expanded a row wouldn't fire real HTTP. The unit tests below
    // never click into the collapsible, so this is purely defensive.
    fetchAcTestMatrix: vi.fn().mockResolvedValue([]),
  };
});

// AcPanel calls useChat() to drop AC refs into the embedded chat when the user
// clicks "investigate →". The tests below never trigger that path; stub the
// hook so the component renders without a ChatProvider wrapper.
vi.mock('./ChatContext', () => ({
  useChat: () => ({
    addContextChip: vi.fn(),
  }),
}));

// AcSparkline does its own width measurement via ResizeObserver in jsdom —
// stub it to a no-op so the component mounts cleanly without polyfills.
beforeEach(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
    class ResizeObserverStub {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
});

// ──────────────────────────────────────────────────────────────────────
// Fixture builders. The shape mirrors the wire format from fetchAcsForBrief
// exactly so the panel's filtering / sorting / counting logic exercises the
// same fields it sees in production.
// ──────────────────────────────────────────────────────────────────────

function makeAc(
  seq: number,
  kind: 'scope' | 'implementation',
  verificationState: AcVerificationState,
  options: { tests?: number; statement?: string } = {},
): AcWithVerification {
  const testCount = options.tests ?? (verificationState === 'untested' ? 0 : 1);
  return {
    ac: {
      id: `ac-${kind}-${seq}`,
      memexId: 'memex-1',
      briefId: 'spec-1',
      seq,
      kind,
      statement: options.statement ?? `${kind} ac ${seq}`,
      status: 'active',
      createdAt: '2026-05-01T00:00:00Z',
      updatedAt: '2026-05-01T00:00:00Z',
    },
    canonicalRef: `mindset-prod/m/specs/spec-1/acs/ac-${seq}`,
    tests: Array.from({ length: testCount }, (_, i) => ({
      testIdentifier: `t_${kind}_${seq}_${i}`,
      latestStatus: verificationState === 'failing' ? 'fail' : 'pass',
      latestRunAt: '2026-05-29T10:00:00Z',
      runCount: 1,
    })),
    verificationState,
    daysSinceLastRun: 0,
    parents: [],
  };
}

function makeHistory(): AcAlignmentDay[] {
  return [
    { date: '2026-05-27', kind: 'scope', verified: 1, total: 2 },
    { date: '2026-05-27', kind: 'implementation', verified: 2, total: 3 },
    { date: '2026-05-28', kind: 'scope', verified: 2, total: 2 },
    { date: '2026-05-28', kind: 'implementation', verified: 3, total: 3 },
  ];
}

describe('AcPanel — unified layout', () => {
  it('renders exactly one unified metric band (not one per kind)', async () => {
    tagAc(`${B96}/acs/ac-1`);
    vi.mocked(fetchAcsForBrief).mockResolvedValue([
      makeAc(1, 'scope', 'verified'),
      makeAc(1, 'implementation', 'verified'),
      makeAc(2, 'implementation', 'failing'),
    ]);
    vi.mocked(fetchAcAlignmentHistory).mockResolvedValue(makeHistory());

    render(<AcPanel docId="doc-1" />);

    // Wait for the data load to complete and the header to mount.
    await waitFor(() =>
      expect(screen.getAllByTestId('ac-unified-header')).toHaveLength(1),
    );
  });

  it('coverage + verification metrics span ALL ACs, not just one kind', async () => {
    tagAc(`${B96}/acs/ac-1`);
    // 4 ACs total. 3 have tests (covered = 75%). Of the 3 covered, 2 verified
    // (verified = 67%). One scope, three implementation — the kind split is
    // intentional so a per-kind computation would surface different numbers
    // and fail this test.
    vi.mocked(fetchAcsForBrief).mockResolvedValue([
      makeAc(1, 'scope', 'verified', { tests: 1 }),
      makeAc(1, 'implementation', 'verified', { tests: 1 }),
      makeAc(2, 'implementation', 'failing', { tests: 1 }),
      makeAc(3, 'implementation', 'untested', { tests: 0 }),
    ]);
    vi.mocked(fetchAcAlignmentHistory).mockResolvedValue([]);

    render(<AcPanel docId="doc-1" />);

    const header = await screen.findByTestId('ac-unified-header');
    // pctCovered = round(3/4 * 100) = 75
    // pctVerified = round(2/3 * 100) = 67
    expect(within(header).getByText('75%')).toBeInTheDocument();
    expect(within(header).getByText('67%')).toBeInTheDocument();
    // Caption surfaces uncovered count (1) — proves the denominator is all
    // ACs, not just one kind's slice.
    expect(within(header).getByText(/1 uncovered/)).toBeInTheDocument();
  });

  it('orders the AC list failing → stale → untested → verified', async () => {
    tagAc(`${B96}/acs/ac-1`);
    // Intentionally mix kinds across states so a sort by kind first would
    // produce the wrong order and fail.
    vi.mocked(fetchAcsForBrief).mockResolvedValue([
      makeAc(1, 'scope', 'verified', { statement: 'a verified scope ac' }),
      makeAc(2, 'implementation', 'failing', { statement: 'a failing impl ac' }),
      makeAc(3, 'implementation', 'untested', {
        tests: 0,
        statement: 'an untested impl ac',
      }),
      makeAc(4, 'scope', 'stale', { statement: 'a stale scope ac' }),
    ]);
    vi.mocked(fetchAcAlignmentHistory).mockResolvedValue([]);

    render(<AcPanel docId="doc-1" />);

    const list = await screen.findByTestId('ac-unified-list');
    const rows = within(list).getAllByRole('listitem');
    // States read off each row's data attribute — pins the structural
    // contract regardless of which DOM child carries the text.
    expect(rows.map((r) => r.getAttribute('data-ac-state'))).toEqual([
      'failing',
      'stale',
      'untested',
      'verified',
    ]);
  });

  it('each AC card shows a scope or impl badge as a soft affordance', async () => {
    tagAc(`${B96}/acs/ac-1`);
    vi.mocked(fetchAcsForBrief).mockResolvedValue([
      makeAc(1, 'scope', 'verified'),
      makeAc(2, 'implementation', 'verified'),
    ]);
    vi.mocked(fetchAcAlignmentHistory).mockResolvedValue([]);

    const { container } = render(<AcPanel docId="doc-1" />);

    await screen.findByTestId('ac-unified-list');

    const scopeBadges = container.querySelectorAll('[data-ac-kind="scope"]');
    const implBadges = container.querySelectorAll(
      '[data-ac-kind="implementation"]',
    );
    expect(scopeBadges).toHaveLength(1);
    expect(implBadges).toHaveLength(1);
    // Labels are the lowercase short forms — small enough to disappear when
    // the eye isn't looking for them.
    expect(scopeBadges[0].textContent).toBe('scope');
    expect(implBadges[0].textContent).toBe('impl');
  });

  it('renders ONE sparkline whose underlying data sums across kinds', async () => {
    tagAc(`${B96}/acs/ac-1`);
    vi.mocked(fetchAcsForBrief).mockResolvedValue([
      makeAc(1, 'scope', 'verified'),
      makeAc(1, 'implementation', 'verified'),
    ]);
    vi.mocked(fetchAcAlignmentHistory).mockResolvedValue(makeHistory());

    const { container } = render(<AcPanel docId="doc-1" />);

    await screen.findByTestId('ac-unified-header');

    // Two days of history in the fixture → one SVG path with one line. If the
    // panel rendered per-kind sparklines we'd see two SVGs.
    const svgs = container.querySelectorAll('svg path[stroke]');
    // AcSparkline renders one path for the line plus optional dots; we just
    // assert there's exactly one *line* path (the one with a non-empty d
    // attribute starting with "M").
    const linePaths = Array.from(svgs).filter((s) =>
      (s.getAttribute('d') ?? '').startsWith('M '),
    );
    expect(linePaths).toHaveLength(1);
  });

  it('still renders the whole-tab empty state when there are zero ACs', async () => {
    tagAc(`${B96}/acs/ac-1`);
    vi.mocked(fetchAcsForBrief).mockResolvedValue([]);
    vi.mocked(fetchAcAlignmentHistory).mockResolvedValue([]);

    render(<AcPanel docId="doc-1" />);

    expect(
      await screen.findByText(/no acceptance criteria on this spec yet/i),
    ).toBeInTheDocument();
    // The unified header must NOT render when the panel is empty — the empty
    // state owns the whole frame.
    expect(screen.queryByTestId('ac-unified-header')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ac-unified-list')).not.toBeInTheDocument();
  });

  it('verified bar shows a rose segment when ACs are failing (not just green + empty)', async () => {
    tagAc(`${B96}/acs/ac-1`);
    // 5 covered ACs: 3 verified, 2 failing. The verified bar should expose
    // those 2 failing as a red chunk instead of leaving them inside the
    // grey track.
    vi.mocked(fetchAcsForBrief).mockResolvedValue([
      makeAc(1, 'scope', 'verified'),
      makeAc(2, 'scope', 'verified'),
      makeAc(3, 'implementation', 'verified'),
      makeAc(4, 'implementation', 'failing'),
      makeAc(5, 'implementation', 'failing'),
    ]);
    vi.mocked(fetchAcAlignmentHistory).mockResolvedValue([]);

    render(<AcPanel docId="doc-1" />);

    const verifiedSegment = await screen.findByTestId('bar-segment-verified');
    const failingSegment = await screen.findByTestId('bar-segment-failing');
    expect(verifiedSegment).toBeInTheDocument();
    expect(failingSegment).toBeInTheDocument();
    expect(failingSegment.className).toContain('bg-rose-500');
    // Segment widths should reflect raw ratios (3/5 = 60%, 2/5 = 40%) so
    // they always sum to 100% of the bar regardless of rounding.
    expect((verifiedSegment as HTMLElement).style.width).toBe('60%');
    expect((failingSegment as HTMLElement).style.width).toBe('40%');
    // No stale ACs in the fixture, so the amber segment is absent.
    expect(screen.queryByTestId('bar-segment-stale')).not.toBeInTheDocument();
  });

  it('verified bar shows only a green segment when nothing is failing or stale', async () => {
    tagAc(`${B96}/acs/ac-1`);
    vi.mocked(fetchAcsForBrief).mockResolvedValue([
      makeAc(1, 'scope', 'verified'),
      makeAc(2, 'implementation', 'verified'),
    ]);
    vi.mocked(fetchAcAlignmentHistory).mockResolvedValue([]);

    render(<AcPanel docId="doc-1" />);

    await screen.findByTestId('bar-segment-verified');
    expect(screen.queryByTestId('bar-segment-failing')).not.toBeInTheDocument();
    expect(screen.queryByTestId('bar-segment-stale')).not.toBeInTheDocument();
  });
});

describe('buildVerifiedSegments', () => {
  it('returns [] when no ACs are covered', () => {
    tagAc(`${B96}/acs/ac-1`);
    expect(buildVerifiedSegments(0, 0, 0, 0)).toEqual([]);
  });

  it('emits only the segments that have non-zero counts', () => {
    tagAc(`${B96}/acs/ac-1`);
    const segments = buildVerifiedSegments(3, 0, 0, 3);
    expect(segments).toHaveLength(1);
    expect(segments[0].colour).toBe('green');
    expect(segments[0].percent).toBe(100);
  });

  it('uses raw ratios so the three segments always sum to exactly 100%', () => {
    tagAc(`${B96}/acs/ac-1`);
    // 3 of 7 verified, 3 failing, 1 stale — round-individually would give
    // 43 + 43 + 14 = 100 (lucky here) but 2 of 7 + 2 + 3 → 29 + 29 + 43 = 101.
    // We use raw ratios precisely to avoid that overflow.
    const segments = buildVerifiedSegments(2, 2, 3, 7);
    const total = segments.reduce((acc, s) => acc + s.percent, 0);
    expect(total).toBeCloseTo(100, 10);
  });

  it('orders segments as verified → failing → stale so the green leads the bar', () => {
    tagAc(`${B96}/acs/ac-1`);
    const segments = buildVerifiedSegments(1, 1, 1, 3);
    expect(segments.map((s) => s.colour)).toEqual(['green', 'rose', 'amber']);
  });
});

// spec-164 (scope ac-3 / ac-10) — the AC panel wears the same card chrome as
// the Decision/Task/Issue panels and carries no offset wrapper, so the
// Decisions and ACs columns start on the same line even when the unified
// header shows coverage/verification statistics.
describe('AcPanel — card chrome + column alignment (spec-164)', () => {
  const AC_CONSISTENT = 'mindset-prod/memex-building-itself/specs/spec-164/acs/ac-3';
  const AC_ALIGNED = 'mindset-prod/memex-building-itself/specs/spec-164/acs/ac-10';

  it('populated panel renders flush with the shared card chrome and uppercase header', async () => {
    tagAc(AC_CONSISTENT);
    tagAc(AC_ALIGNED);
    vi.mocked(fetchAcsForBrief).mockResolvedValue([
      makeAc(1, 'scope', 'verified'),
      makeAc(2, 'implementation', 'failing'),
    ]);
    vi.mocked(fetchAcAlignmentHistory).mockResolvedValue(makeHistory());

    render(<AcPanel docId="spec-1" />);
    const panel = await screen.findByTestId('ac-panel');
    // Same card chrome family as decision-panel / task-panel / issue-panel…
    expect(panel.className).toContain('border-edge');
    expect(panel.className).toContain('bg-panel');
    // …and no offset wrapper pushing the column down or inward.
    expect(panel.className).not.toContain('py-4');
    expect(panel.className).not.toContain('px-2');
    expect(within(panel).getByText('Acceptance Criteria')).toBeInTheDocument();
    // The verification statistics render INSIDE the card, below the header,
    // so they can never push the column start out of line.
    expect(within(panel).getByTestId('ac-unified-header')).toBeInTheDocument();
  });

  it('the zero-AC teaching card also renders flush (no offset wrapper)', async () => {
    tagAc(AC_ALIGNED);
    vi.mocked(fetchAcsForBrief).mockResolvedValue([]);
    vi.mocked(fetchAcAlignmentHistory).mockResolvedValue([]);

    render(<AcPanel docId="spec-1" />);
    const panel = await screen.findByTestId('ac-panel');
    expect(panel.className).not.toContain('py-4');
    expect(panel.className).not.toContain('max-w-3xl');
  });
});

// spec-164 dec-3 — the AC half of the draft gate: zero ACs in draft invites
// the move to Specify; existing ACs always render.
describe('AcPanel — draft-phase gating (spec-164)', () => {
  const AC164 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-164/acs/ac-${n}`;

  it('draft + zero ACs → empty-state directive instead of the teaching card', async () => {
    tagAc(AC164(17));
    vi.mocked(fetchAcsForBrief).mockResolvedValue([]);
    vi.mocked(fetchAcAlignmentHistory).mockResolvedValue([]);
    render(<AcPanel docId="spec-1" specPhase="draft" />);
    expect(await screen.findByTestId('ac-draft-directive')).toHaveTextContent(
      'Move this spec to Specify to start capturing Decisions and ACs.',
    );
    expect(screen.queryByText('No acceptance criteria on this Spec yet')).not.toBeInTheDocument();
  });

  it('draft + existing ACs → normal render, content never hidden', async () => {
    tagAc(AC164(18));
    vi.mocked(fetchAcsForBrief).mockResolvedValue([makeAc(1, 'scope', 'verified')]);
    vi.mocked(fetchAcAlignmentHistory).mockResolvedValue([]);
    render(<AcPanel docId="spec-1" specPhase="draft" />);
    expect(await screen.findByTestId('ac-unified-header')).toBeInTheDocument();
    expect(screen.queryByTestId('ac-draft-directive')).not.toBeInTheDocument();
  });

  it('specify + zero ACs → the teaching card renders as before (no directive)', async () => {
    tagAc(AC164(18));
    vi.mocked(fetchAcsForBrief).mockResolvedValue([]);
    vi.mocked(fetchAcAlignmentHistory).mockResolvedValue([]);
    render(<AcPanel docId="spec-1" specPhase="specify" />);
    expect(
      await screen.findByText('No acceptance criteria on this Spec yet'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('ac-draft-directive')).not.toBeInTheDocument();
  });
});
