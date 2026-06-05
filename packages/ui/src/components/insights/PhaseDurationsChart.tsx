// spec-179 (ac-2): phase durations — two panels.
//  Left: how long active specs have been sitting in their current phase
//        (horizontal bars, avg days, median + n in the tooltip/labels;
//        right-censored — the clocks are still running).
//  Right: exact draft→done cycle-time distribution for completed specs,
//         binned client-side from the endpoint's raw valuesDays.

import { ResponsiveBar } from '@nivo/bar';
import type { PhaseDurations } from '../../api/client';
import { ACCENT, PHASE_COLORS, insightsTheme, phaseLabel, type Phase } from './theme';

interface Props {
  durations: PhaseDurations;
}

const BINS: Array<{ label: string; lo: number; hi: number }> = [
  { label: '<1d', lo: 0, hi: 1 },
  { label: '1–2d', lo: 1, hi: 2 },
  { label: '2–4d', lo: 2, hi: 4 },
  { label: '4–7d', lo: 4, hi: 7 },
  { label: '1–2w', lo: 7, hi: 14 },
  { label: '2–3w', lo: 14, hi: 21 },
  { label: '3w+', lo: 21, hi: Infinity },
];

export function PhaseDurationsChart({ durations }: Props) {
  const { inPhase, cycleTime } = durations;

  // In-flight phases only — `done` is terminal, its "age" is just time since
  // completion, which the cycle-time panel covers properly.
  const inFlight = inPhase.filter((r) => r.phase !== 'done');
  const inPhaseData = inFlight
    .slice()
    .reverse() // horizontal bars render bottom-up; reverse keeps lifecycle order top-down
    .map((r) => ({ phase: r.phase, avgDays: r.avgDays, medianDays: r.medianDays, n: r.n }));

  const histogram = BINS.map((b) => ({
    bin: b.label,
    count: cycleTime.valuesDays.filter((v) => v >= b.lo && v < b.hi).length,
  }));

  return (
    <div data-testid="phase-durations-chart" className="flex flex-col gap-4">
      <div className="h-64">
        <div className="text-xs text-secondary mb-1">
          Time in current phase (active specs — still counting)
        </div>
        <ResponsiveBar
          data={inPhaseData}
          keys={['avgDays']}
          indexBy="phase"
          layout="horizontal"
          margin={{ top: 4, right: 48, bottom: 40, left: 56 }}
          padding={0.35}
          colors={(bar) => PHASE_COLORS[bar.data.phase as Phase]}
          borderRadius={3}
          theme={insightsTheme}
          enableGridY={false}
          enableGridX
          label={(d) => `${d.value}d`}
          labelSkipWidth={28}
          axisBottom={{ tickSize: 0, tickPadding: 6, legend: 'avg days', legendOffset: 30 }}
          axisLeft={{ tickSize: 0, tickPadding: 8, format: (v) => phaseLabel(String(v)) }}
          tooltip={({ data: d }) => (
            <div className="text-xs">
              <div className="font-medium">{phaseLabel(String(d.phase))}</div>
              <div>avg {d.avgDays}d · median {d.medianDays}d · n={d.n}</div>
            </div>
          )}
          animate
        />
      </div>
      <div className="h-64">
        <div className="text-xs text-secondary mb-1">
          {cycleTime.n > 0
            ? `Draft → done cycle time (n=${cycleTime.n}, median ${cycleTime.medianDays}d, avg ${cycleTime.avgDays}d)`
            : 'Draft → done cycle time — no completed specs yet'}
        </div>
        <ResponsiveBar
          data={histogram}
          keys={['count']}
          indexBy="bin"
          margin={{ top: 4, right: 8, bottom: 40, left: 36 }}
          padding={0.15}
          colors={[`${ACCENT}cc`]}
          borderRadius={3}
          theme={insightsTheme}
          enableLabel={false}
          axisBottom={{ tickSize: 0, tickPadding: 6, legend: 'days to done', legendOffset: 30 }}
          axisLeft={{ tickSize: 0, tickPadding: 6 }}
          tooltip={({ indexValue, value }) => (
            <div className="text-xs">
              <span className="font-medium">{String(value)}</span> specs finished in {String(indexValue)}
            </div>
          )}
          animate
        />
      </div>
    </div>
  );
}
