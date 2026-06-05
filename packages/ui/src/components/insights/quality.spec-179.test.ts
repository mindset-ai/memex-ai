// spec-179 — static quality gates for the charting stack (ac-6, ac-8, ac-4).
//
// These assert the OBSERVABLE halves of the quality ACs from source + manifest:
//   ac-6: scoped @nivo packages only, exact-pinned, one version (std-24).
//   ac-8: every chart component uses THE shared theme — no inline theme objects.
//   ac-4: every chart is animated and carries a rich custom tooltip.
// The subjective half of ac-4 ("visually first-class") stays a human check in
// the verify pass; these gates stop regressions from quietly shipping
// default-styled or off-theme charts.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tagAc } from '@memex-ai-ac/vitest';

const AC_PACKAGES = 'mindset-prod/memex-building-itself/specs/spec-179/acs/ac-6';
const AC_THEME = 'mindset-prod/memex-building-itself/specs/spec-179/acs/ac-8';
const AC_POLISH = 'mindset-prod/memex-building-itself/specs/spec-179/acs/ac-4';

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_ROOT = join(HERE, '../../..');

// The chart components this spec shipped. New Nivo charts should be added
// here so the theme/polish gates cover them.
const CHART_FILES = [
  'SpecsOverTimeChart.tsx',
  'SpecsByPhaseChart.tsx',
  'PhaseDurationsChart.tsx',
  'PipelineFunnelChart.tsx',
  'ActivityStreamChart.tsx',
  'AcVerificationChart.tsx',
  'AcsOverTimeChart.tsx',
  'TestRunVolumeChart.tsx',
];

function chartSource(file: string): string {
  return readFileSync(join(HERE, file), 'utf8');
}

describe('ac-6: scoped Nivo packages, exact-pinned, one version (std-24)', () => {
  it('package.json carries only scoped @nivo/* deps at one exact version', () => {
    tagAc(AC_PACKAGES);
    const pkg = JSON.parse(readFileSync(join(UI_ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    const nivoEntries = Object.entries(pkg.dependencies).filter(([name]) =>
      name.startsWith('@nivo/'),
    );
    expect(nivoEntries.length).toBeGreaterThan(0);
    // No meta-install — the unscoped 'nivo' package pulls every chart.
    expect(pkg.dependencies['nivo']).toBeUndefined();
    for (const [name, version] of nivoEntries) {
      // Exact pin: no range operators.
      expect(version, `${name} must be exact-pinned`).toMatch(/^\d+\.\d+\.\d+$/);
    }
    // One version across the family.
    expect(new Set(nivoEntries.map(([, v]) => v)).size).toBe(1);
  });
});

describe('ac-8: one shared theme across every chart component', () => {
  it('every chart imports insightsTheme and passes it as the theme prop', () => {
    tagAc(AC_THEME);
    for (const file of CHART_FILES) {
      const src = chartSource(file);
      expect(src, `${file} must import the shared theme`).toContain("from './theme'");
      expect(src, `${file} must use the shared theme`).toContain('theme={insightsTheme}');
      // No ad-hoc inline theme objects bypassing the shared one.
      expect(src, `${file} must not define an inline theme`).not.toMatch(/theme=\{\{/);
    }
  });

  it('no chart component slipped out of the gate list', () => {
    tagAc(AC_THEME);
    // Any .tsx in insights/ that renders a Nivo Responsive* chart must be in
    // CHART_FILES — otherwise the theme/polish gates silently don't cover it.
    const all = readdirSync(HERE).filter((f) => f.endsWith('.tsx') && !f.includes('.test.'));
    const nivoCharts = all.filter((f) => /from '@nivo\//.test(chartSource(f)));
    expect(nivoCharts.sort()).toEqual([...CHART_FILES].sort());
  });
});

describe('ac-4: charts are animated with rich hover tooltips', () => {
  it('every chart enables animation and a custom tooltip', () => {
    tagAc(AC_POLISH);
    for (const file of CHART_FILES) {
      const src = chartSource(file);
      expect(src, `${file} must animate`).toMatch(/\banimate\b/);
      expect(src, `${file} must carry a custom tooltip`).toMatch(/tooltip=\{|sliceTooltip=\{/i);
    }
  });
});
