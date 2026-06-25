// spec-406 — UI gates for the per-spec Stats tab. Renders the components against
// fixed data + asserts the structural wiring (tab registration, CHART_FILES).

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tagAc } from '@memex-ai-ac/vitest';

const A = (n: number) => `mindset-prod/memex-building-itself/specs/spec-406/acs/ac-${n}`;
const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(HERE, rel), 'utf8');

// ── Mock the spec-stats API so StatsView resolves to fixed data ──────────────
const SUMMARY = {
  createdAt: '2026-06-01T00:00:00.000Z',
  currentPhase: 'build',
  ageDays: 24,
  timeInCurrentPhaseDays: 19,
  tasks: { total: 3, complete: 1 },
  acs: { total: 3, verified: 1, failing: 1, covered: 2 },
};
const DURATIONS = {
  segments: [
    { phase: 'draft', start: '2026-06-01T00:00:00.000Z', end: '2026-06-02T00:00:00.000Z' },
    { phase: 'specify', start: '2026-06-02T00:00:00.000Z', end: '2026-06-03T00:00:00.000Z' },
    { phase: 'build', start: '2026-06-03T00:00:00.000Z', end: '2026-06-05T00:00:00.000Z' },
    { phase: 'verify', start: '2026-06-05T00:00:00.000Z', end: '2026-06-06T00:00:00.000Z' },
    { phase: 'build', start: '2026-06-06T00:00:00.000Z', end: null },
  ],
  totals: [
    { phase: 'draft', days: 1 },
    { phase: 'specify', days: 1 },
    { phase: 'build', days: 21 },
    { phase: 'verify', days: 1 },
  ],
  hasTransitionHistory: true,
  fullHistory: true,
  caveat: null,
};
const VELOCITY = {
  points: [
    { day: '2026-06-03', created: 3, started: 1, completed: 0 },
    { day: '2026-06-04', created: 0, started: 0, completed: 1 },
  ],
  statusBreakdown: { not_started: 1, in_progress: 1, complete: 1 },
};
const VERIFICATION = { total: 3, verified: 1, failing: 1, untested: 1 };

vi.mock('../../api/insights', () => ({
  fetchSpecSummary: () => Promise.resolve(SUMMARY),
  fetchSpecPhaseDurations: () => Promise.resolve(DURATIONS),
  fetchSpecTaskVelocity: () => Promise.resolve(VELOCITY),
  fetchSpecAcVerification: () => Promise.resolve(VERIFICATION),
  fetchSpecActivity: () => Promise.resolve({ rows: [], hasMore: false }),
}));

// Import AFTER the mock is declared.
import { SpecPhaseTimelineChart } from './SpecPhaseTimelineChart';
import { SpecTaskVelocityChart } from './SpecTaskVelocityChart';
import { StatsView } from './StatsView';

describe('ac-16: phase timeline draws a date-axis segment per visit, re-entries separate', () => {
  it('renders one segment per phase visit, with the re-entered phase appearing twice', () => {
    tagAc(A(16));
    render(<SpecPhaseTimelineChart data={DURATIONS as never} />);
    const segs = screen.getAllByTestId('phase-segment');
    expect(segs).toHaveLength(5); // draft, specify, build, verify, build(re-entry)
    expect(segs.filter((s) => s.getAttribute('data-phase') === 'build')).toHaveLength(2);
    // Positioned on a date axis: each segment carries an absolute left + width.
    for (const s of segs) {
      expect(s.style.left).not.toBe('');
      expect(s.style.width).not.toBe('');
    }
  });
});

describe('ac-17: reserved hues via useChartPalette + new Nivo chart registered in CHART_FILES', () => {
  it('the timeline sources phase hues from the shared palette', () => {
    tagAc(A(17));
    const src = read('SpecPhaseTimelineChart.tsx');
    expect(src).toContain('useChartPalette');
    expect(src).toContain('phaseColors[seg.phase]');
  });

  it('the new Nivo velocity chart is registered in the chart-quality gate list', () => {
    tagAc(A(17));
    const gate = read('quality.spec-179.test.ts');
    expect(gate).toContain("'SpecTaskVelocityChart.tsx'");
  });
});

describe('ac-18: a stats SubTab is wired into the Spec page', () => {
  it('the SubTab union and DocDocument both carry the stats tab', () => {
    tagAc(A(18));
    const hook = read('../../hooks/useDocTabs.ts');
    expect(hook).toMatch(/SubTab =[^;]*'stats'/s);
    const page = read('../../pages/DocDocument.tsx');
    expect(page).toContain("id: 'stats'");
    expect(page).toContain("effectiveSubTab === 'stats'");
    expect(page).toContain('<StatsView');
  });
});

describe('ac-19/20/21: StatsView renders all five surfaces in order with their data', () => {
  it('renders summary → phase timeline → velocity + AC donut → audit (ac-19)', async () => {
    tagAc(A(19));
    tagAc(A(1)); // scope: the Stats tab body renders without error
    const { container } = render(<StatsView specRef="spec-1" />);
    await screen.findByTestId('spec-stats-view');
    const ids = [
      'spec-summary-strip',
      'spec-phase-timeline',
      'spec-task-velocity-chart',
      'ac-verification-chart',
      'spec-activity-audit',
    ];
    for (const id of ids) expect(screen.getByTestId(id)).toBeInTheDocument();
    // Order: each appears before the next in the DOM.
    const html = container.innerHTML;
    for (let i = 1; i < ids.length; i++) {
      expect(html.indexOf(ids[i - 1])).toBeLessThan(html.indexOf(ids[i]));
    }
  });

  it('the summary strip shows created, phase, age, task progress and AC verification (ac-20)', async () => {
    tagAc(A(20));
    render(<StatsView specRef="spec-1" />);
    await screen.findByTestId('spec-summary-strip');
    expect(screen.getByText('Created')).toBeInTheDocument();
    expect(screen.getByText('Phase')).toBeInTheDocument();
    expect(screen.getByText('Age')).toBeInTheDocument();
    expect(screen.getByText('Tasks')).toBeInTheDocument();
    expect(screen.getByText('ACs verified')).toBeInTheDocument();
  });

  it('renders the task-velocity chart and the AC verification donut (ac-21)', async () => {
    tagAc(A(21));
    render(<StatsView specRef="spec-1" />);
    await screen.findByTestId('spec-stats-view');
    expect(screen.getByTestId('spec-task-velocity-chart')).toBeInTheDocument();
    expect(screen.getByTestId('ac-verification-chart')).toBeInTheDocument();
  });
});

describe('ac-5: shared palette + explanatory empty states when a metric has no data', () => {
  it('the phase timeline and velocity chart show an empty state instead of bare axes', () => {
    tagAc(A(5));
    const { rerender } = render(
      <SpecPhaseTimelineChart
        data={{ segments: [], totals: [], hasTransitionHistory: false, fullHistory: false, caveat: null } as never}
      />,
    );
    expect(screen.getByTestId('spec-phase-timeline')).toHaveTextContent(/unlocks on its first transition/i);
    rerender(<SpecTaskVelocityChart points={[]} />);
    expect(screen.getByTestId('spec-task-velocity-chart')).toHaveTextContent(/No tasks yet/i);
    // The charts draw from the shared palette, not per-chart constants.
    expect(read('SpecPhaseTimelineChart.tsx')).toContain('useChartPalette');
    expect(read('SpecTaskVelocityChart.tsx')).toContain('useChartPalette');
  });
});
