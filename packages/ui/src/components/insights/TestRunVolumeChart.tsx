// spec-179 (ac-19): test-run volume — "how hard is the verification loop
// running?" Per-day test emissions stacked by status. Pass dominates a
// healthy memex; red/amber bands surfacing mid-stack are regressions landing
// in real time.

import { ResponsiveBar } from '@nivo/bar';
import type { TestRunVolumePoint } from '../../api/client';
import { TOOLTIP_STYLE, insightsTheme, shortDate } from './theme';

interface Props {
  points: TestRunVolumePoint[];
}

const STATUS_COLORS: Record<string, string> = {
  pass: '#22c55e', // green
  fail: '#ef4444', // red
  error: '#f59e0b', // amber — infrastructure, not assertion
};

export function TestRunVolumeChart({ points }: Props) {
  const data = points.map((p) => ({ ...p }));
  const every = Math.max(1, Math.ceil(points.length / 10));
  const tickValues = points.filter((_, i) => i % every === 0).map((p) => p.day);
  const total = points.reduce((s, p) => s + p.pass + p.fail + p.error, 0);

  return (
    <div data-testid="test-run-volume-chart" className="h-72">
      <ResponsiveBar
        data={data}
        keys={['pass', 'fail', 'error']}
        indexBy="day"
        margin={{ top: 24, right: 16, bottom: 36, left: 48 }}
        padding={0.25}
        colors={(bar) => STATUS_COLORS[bar.id as string]}
        borderRadius={2}
        theme={insightsTheme}
        enableLabel={false}
        axisBottom={{ tickSize: 0, tickPadding: 8, tickValues, format: shortDate }}
        axisLeft={{ tickSize: 0, tickPadding: 8 }}
        enableGridY
        legends={[
          {
            dataFrom: 'keys',
            anchor: 'top-left',
            direction: 'row',
            translateY: -24,
            itemWidth: 64,
            itemHeight: 16,
            symbolSize: 10,
            symbolShape: 'circle',
          },
        ]}
        tooltip={({ id, value, data: d }) => (
          <div
            className="text-xs rounded-lg px-3 py-2"
            style={TOOLTIP_STYLE}
          >
            <div className="font-medium">{shortDate(String(d.day))}</div>
            <div>
              <span className="font-medium" style={{ color: STATUS_COLORS[String(id)] }}>
                {value}
              </span>{' '}
              {String(id)} · {d.pass + d.fail + d.error} runs total
            </div>
          </div>
        )}
        animate
      />
      <span className="sr-only">{`${total} test runs in range`}</span>
    </div>
  );
}
