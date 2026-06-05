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

// Display labels — the `plan` phase reads as "specify" in the product, while
// the DB status value (and every data key / API shape) stays 'plan'. Map at
// render time only, in one place, so a future DB-level rename is a one-line
// change here.
export const PHASE_LABELS: Record<Phase, string> = {
  draft: 'draft',
  plan: 'specify',
  build: 'build',
  verify: 'verify',
  done: 'done',
};

export function phaseLabel(phase: string): string {
  return PHASE_LABELS[phase as Phase] ?? phase;
}

/** Accent for the cumulative line / single-series charts. */
export const ACCENT = '#6366f1'; // indigo-500

// The app's design tokens (index.css) are space-separated RGB *channels*
// (e.g. `--color-edge: 62 68 81`), built to be consumed via `rgb(var(--token))`
// — never bare. The previous values here used the tokens bare and even invented
// `--color-border` (which doesn't exist), so every entry silently fell back to
// its hardcoded hex. That hardcoded slate-200 (`#e2e8f0`) is the harsh
// near-white hairline seen in dark mode. Wrapping the real tokens in `rgb()`
// (with an alpha channel for the hairlines) makes them resolve per-theme.
//
// Hairline (grid + axis ticks): the edge token at 0.5 alpha — subtle in light
// (slate-200/50) and a soft grey in dark (#3e4451/50). The hex fallback is a
// semi-transparent slate so a missing token can never produce a hard line.
const HAIRLINE = 'rgb(var(--color-edge, 148 163 184) / 0.5)';

export const insightsTheme: PartialTheme = {
  background: 'transparent',
  text: {
    fontSize: 11,
    fill: 'rgb(var(--color-text-secondary, 100 116 139))',
  },
  axis: {
    ticks: {
      line: { stroke: HAIRLINE, strokeWidth: 1 },
      text: { fontSize: 10, fill: 'rgb(var(--color-text-secondary, 100 116 139))' },
    },
    legend: { text: { fontSize: 11, fill: 'rgb(var(--color-text-secondary, 100 116 139))' } },
  },
  grid: {
    line: { stroke: HAIRLINE, strokeWidth: 1, strokeDasharray: '2 4' },
  },
  tooltip: {
    container: {
      background: 'rgb(var(--color-surface, 255 255 255))',
      color: 'rgb(var(--color-text-primary, 15 23 42))',
      fontSize: 12,
      borderRadius: 8,
      boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
      padding: '8px 12px',
    },
  },
  crosshair: {
    line: { stroke: 'rgb(var(--color-text-secondary, 148 163 184))', strokeWidth: 1, strokeOpacity: 0.5 },
  },
};

/** Compact date for axis ticks: '2026-06-05' → 'Jun 5'. */
export function shortDate(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
