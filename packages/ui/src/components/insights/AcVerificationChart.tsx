// spec-179 (ac-18): the AC verification donut — "is the work proven?"
// One memex-wide rollup of every active AC's latest test emissions:
// verified (all green), failing (a red among the latest), untested (no
// emissions at all — invisible to verification). The center carries the
// verified percentage; untested is the slice a lead should chase.

import { ResponsivePie } from '@nivo/pie';
import type { AcVerificationSummary } from '../../api/client';
import { TOOLTIP_STYLE, insightsTheme } from './theme';

interface Props {
  summary: AcVerificationSummary;
}

const SLICE_COLORS: Record<string, string> = {
  verified: '#22c55e', // green — proven
  failing: '#ef4444', // red — broken proof
  untested: '#94a3b8', // slate — invisible to verification
};

export function AcVerificationChart({ summary }: Props) {
  const data = (
    [
      { id: 'verified', value: summary.verified },
      { id: 'failing', value: summary.failing },
      { id: 'untested', value: summary.untested },
    ] as const
  ).filter((d) => d.value > 0);

  const pct = summary.total > 0 ? Math.round((summary.verified / summary.total) * 100) : 0;

  if (summary.total === 0) {
    return (
      <div
        data-testid="ac-verification-chart"
        className="h-72 flex items-center justify-center text-sm text-secondary"
      >
        No acceptance criteria yet.
      </div>
    );
  }

  return (
    <div data-testid="ac-verification-chart" className="relative h-72">
      <ResponsivePie
        data={[...data]}
        margin={{ top: 24, right: 96, bottom: 24, left: 96 }}
        colors={(d) => SLICE_COLORS[String(d.id)]}
        theme={insightsTheme}
        innerRadius={0.7}
        padAngle={1.5}
        cornerRadius={4}
        activeOuterRadiusOffset={6}
        enableArcLabels={false}
        arcLinkLabel={(d) => `${d.id} (${d.value})`}
        arcLinkLabelsColor={{ from: 'color' }}
        arcLinkLabelsTextColor="rgb(var(--color-text-secondary, 100 116 139))"
        arcLinkLabelsThickness={1.5}
        tooltip={({ datum }) => (
          <div
            className="text-xs rounded-lg px-3 py-2"
            style={TOOLTIP_STYLE}
          >
            <span className="font-medium">{datum.value}</span> of {summary.total} ACs{' '}
            {String(datum.id)}
          </div>
        )}
        animate
      />
      {/* Donut center: the verified share — the number a lead actually tracks. */}
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
        <div className="text-2xl font-semibold">{pct}%</div>
        <div className="text-xs text-secondary">verified</div>
      </div>
    </div>
  );
}
