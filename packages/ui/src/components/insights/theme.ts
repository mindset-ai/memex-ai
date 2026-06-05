// spec-179 (ac-8): the ONE Nivo theme + phase palette every Insights chart
// shares — no per-chart ad-hoc styling drift.
//
// Phase hues follow the semantic families of utils/statusStyles.ts (draft =
// neutral, plan = warning/amber, build = info/blue, verify + done = the
// success family). verify and done share a family in the badge system but a
// stacked chart needs distinct hues, so verify takes the family's teal end
// and done its green core.

import type { PartialTheme } from '@nivo/theming';

export const PHASE_ORDER = ['draft', 'plan', 'build', 'verify', 'done'] as const;
export type Phase = (typeof PHASE_ORDER)[number];

export const PHASE_COLORS: Record<Phase, string> = {
  draft: '#94a3b8', // slate-400  — neutral
  plan: '#f59e0b', // amber-500  — warning
  build: '#3b82f6', // blue-500   — info
  verify: '#14b8a6', // teal-500   — success family, acceptance gate
  done: '#22c55e', // green-500  — success
};

/** Accent for the cumulative line / single-series charts. */
export const ACCENT = '#6366f1'; // indigo-500

export const insightsTheme: PartialTheme = {
  background: 'transparent',
  text: {
    fontSize: 11,
    fill: 'var(--color-text-secondary, #64748b)',
  },
  axis: {
    ticks: {
      line: { stroke: 'var(--color-border, #e2e8f0)', strokeWidth: 1 },
      text: { fontSize: 10, fill: 'var(--color-text-secondary, #94a3b8)' },
    },
    legend: { text: { fontSize: 11, fill: 'var(--color-text-secondary, #64748b)' } },
  },
  grid: {
    line: { stroke: 'var(--color-border, #e2e8f0)', strokeWidth: 1, strokeDasharray: '2 4' },
  },
  tooltip: {
    container: {
      background: 'var(--color-surface, #ffffff)',
      color: 'var(--color-text-primary, #0f172a)',
      fontSize: 12,
      borderRadius: 8,
      boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
      padding: '8px 12px',
    },
  },
  crosshair: {
    line: { stroke: 'var(--color-text-secondary, #94a3b8)', strokeWidth: 1, strokeOpacity: 0.5 },
  },
};

/** Compact date for axis ticks: '2026-06-05' → 'Jun 5'. */
export function shortDate(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
