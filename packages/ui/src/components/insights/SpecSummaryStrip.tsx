// spec-406 (dec-5): the lifecycle summary strip — the at-a-glance header of the
// Stats tab. Created date · current phase · age · time-in-current-phase · task
// progress · AC verification. All values are server-computed (SQL); this just
// formats them.

import type { SpecLifecycleSummary } from '../../api/insights';
import { phaseLabel, shortDate, useChartPalette } from './theme';

interface Props {
  summary: SpecLifecycleSummary;
}

const fmtDays = (d: number) => (d >= 1 ? `${d.toFixed(d >= 10 ? 0 : 1)}d` : `${Math.round(d * 24)}h`);

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-xs text-secondary">{label}</span>
      <span className="text-lg font-semibold leading-tight">{value}</span>
      {sub && <span className="text-xs text-secondary">{sub}</span>}
    </div>
  );
}

export function SpecSummaryStrip({ summary }: Props) {
  const { phase: phaseColors } = useChartPalette();
  const taskPct = summary.tasks.total > 0 ? Math.round((summary.tasks.complete / summary.tasks.total) * 100) : 0;
  const acPct = summary.acs.total > 0 ? Math.round((summary.acs.verified / summary.acs.total) * 100) : 0;

  return (
    <div
      data-testid="spec-summary-strip"
      className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4"
    >
      <Stat label="Created" value={shortDate(summary.createdAt.slice(0, 10))} />
      <div className="flex flex-col">
        <span className="text-xs text-secondary">Phase</span>
        <span className="text-lg font-semibold leading-tight inline-flex items-center gap-1.5">
          <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: phaseColors[summary.currentPhase] }} />
          {phaseLabel(summary.currentPhase)}
        </span>
        <span className="text-xs text-secondary">{fmtDays(summary.timeInCurrentPhaseDays)} in phase</span>
      </div>
      <Stat label="Age" value={fmtDays(summary.ageDays)} />
      <Stat
        label="Tasks"
        value={`${taskPct}%`}
        sub={`${summary.tasks.complete}/${summary.tasks.total} complete`}
      />
      <Stat
        label="ACs verified"
        value={`${acPct}%`}
        sub={`${summary.acs.verified}/${summary.acs.total} verified`}
      />
      <Stat
        label="AC coverage"
        value={summary.acs.total > 0 ? `${Math.round((summary.acs.covered / summary.acs.total) * 100)}%` : '—'}
        sub={`${summary.acs.covered}/${summary.acs.total} tested`}
      />
    </div>
  );
}
