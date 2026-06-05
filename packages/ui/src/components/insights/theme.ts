// spec-179 (ac-8): the ONE Nivo theme + chart palette every Insights chart
// shares — no per-chart ad-hoc styling drift.
//
// Series colors are vivid Tailwind 400-level hues for dark mode (they read as
// luminous on the near-black surface) and their 500/600 counterparts for light,
// picked per theme via useChartPalette(). They are literal hex strings, not
// CSS variables, because Nivo composes colors in JS (`${accent}55` alpha
// suffixes, 'darker' modifiers) where a `rgb(var(--…))` string would silently
// break. The polish lives as much in TREATMENT as hue: charts use translucent
// fills with crisp full-strength edges, not solid slabs.
//
// Hue semantics: draft = slate (not yet real work), specify = amber,
// build = blue, verify = cyan, done = emerald; violet is the accent for
// cumulative/"intent" series; rose is reserved for failure.

import type { CSSProperties } from 'react';
import type { PartialTheme } from '@nivo/theming';
import { useThemeName } from '../ThemeContext';

export const PHASE_ORDER = ['draft', 'plan', 'build', 'verify', 'done'] as const;
export type Phase = (typeof PHASE_ORDER)[number];

export interface ChartPalette {
  phase: Record<Phase, string>;
  /** Cumulative / "intent" series: hero line, cycle-time histogram, ACs created. */
  accent: string;
  verification: { verified: string; failing: string; untested: string };
  testRun: { pass: string; fail: string; error: string };
  actor: { human: string; mcp_agent: string; in_app_agent: string };
}

export const CHART_PALETTES: Record<'dark' | 'light', ChartPalette> = {
  dark: {
    // Tailwind 400s — luminous on the dark surface.
    phase: {
      draft: '#64748b', // slate-500
      plan: '#fbbf24', // amber-400
      build: '#60a5fa', // blue-400
      verify: '#22d3ee', // cyan-400
      done: '#34d399', // emerald-400
    },
    accent: '#a78bfa', // violet-400
    verification: { verified: '#34d399', failing: '#fb7185', untested: '#64748b' },
    testRun: { pass: '#34d399', fail: '#fb7185', error: '#fbbf24' },
    // human = blue (the app accent family), coding agents = violet (the
    // app's agent hue family), memex agent = cyan.
    actor: { human: '#60a5fa', mcp_agent: '#a78bfa', in_app_agent: '#22d3ee' },
  },
  light: {
    // The same hues one or two stops deeper for the white surface.
    phase: {
      draft: '#94a3b8', // slate-400
      plan: '#f59e0b', // amber-500
      build: '#3b82f6', // blue-500
      verify: '#0891b2', // cyan-600
      done: '#10b981', // emerald-500
    },
    accent: '#8b5cf6', // violet-500
    verification: { verified: '#10b981', failing: '#f43f5e', untested: '#94a3b8' },
    testRun: { pass: '#10b981', fail: '#f43f5e', error: '#f59e0b' },
    actor: { human: '#3b82f6', mcp_agent: '#8b5cf6', in_app_agent: '#0891b2' },
  },
};

/** The chart palette for the active theme (defaults to dark outside the provider). */
export function useChartPalette(): ChartPalette {
  return CHART_PALETTES[useThemeName()];
}

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

// Shared inline style for the CUSTOM tooltip divs the charts render (slice /
// part / bar tooltips replace Nivo's container entirely, so the theme.tooltip
// block above doesn't reach them). Same rgb(var()) discipline as the theme —
// the bare-var form silently fell back to white-on-light-text in dark mode.
export const TOOLTIP_STYLE: CSSProperties = {
  background: 'rgb(var(--color-surface, 255 255 255))',
  color: 'rgb(var(--color-text-primary, 15 23 42))',
  boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
};

/**
 * ≤6 evenly-spaced INTEGER ticks for count axes. Nivo's default linear ticks
 * happily emit 0.5/1.5/… which reads as nonsense for spec/AC/test counts —
 * pass these to both tickValues and gridYValues.
 */
export function integerTicks(max: number): number[] {
  const top = Math.max(1, Math.ceil(max));
  const step = Math.max(1, Math.ceil(top / 5));
  const ticks: number[] = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  return ticks;
}

/** Compact date for axis ticks: '2026-06-05' → 'Jun 5'. */
export function shortDate(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
