// spec-179 (ac-18): the pipeline funnel — "where does work pile up?"
// Each stage is the count of active specs currently AT or BEYOND that phase,
// so the narrowing from draft → done is the pipeline's real conversion shape.
// Phase colors match the shared palette; labels use the product vocabulary
// (plan → "specify").

import { ResponsiveFunnel } from '@nivo/funnel';
import type { FunnelStage } from '../../api/client';
import { PHASE_COLORS, TOOLTIP_STYLE, insightsTheme, phaseLabel, type Phase } from './theme';

interface Props {
  stages: FunnelStage[];
}

export function PipelineFunnelChart({ stages }: Props) {
  const data = stages.map((s) => ({
    id: s.phase,
    label: phaseLabel(s.phase),
    value: s.count,
  }));

  return (
    <div data-testid="pipeline-funnel-chart" className="h-72">
      <ResponsiveFunnel
        data={data}
        margin={{ top: 16, right: 120, bottom: 16, left: 120 }}
        colors={(d) => PHASE_COLORS[d.id as Phase]}
        theme={insightsTheme}
        shapeBlending={0.66}
        valueFormat=">-.0f"
        borderWidth={12}
        labelColor={{ from: 'color', modifiers: [['darker', 2.4]] }}
        beforeSeparatorLength={48}
        afterSeparatorLength={48}
        currentPartSizeExtension={8}
        currentBorderWidth={16}
        tooltip={({ part }) => (
          <div
            className="text-xs rounded-lg px-3 py-2"
            style={TOOLTIP_STYLE}
          >
            <span className="font-medium">{part.data.value}</span> specs reached{' '}
            {phaseLabel(String(part.data.id))}
          </div>
        )}
        animate
      />
    </div>
  );
}
