// spec-566 t-5 — the scan half of ac-11.
//
//   ac-11  "…plus a scan that catches a coverage surface added later without
//          one." Per-surface mounts prove the nine that exist today. This proves
//          the TENTH — the one somebody writes next year — cannot ship the
//          badge dec-2 rejected, which is the failure mode that looks completely
//          fine in review.
//
// HOW IT DECIDES, and why not a hand-maintained file list. A list of nine paths
// is satisfied by a tenth file the list has never heard of, so the list would
// guard nothing. The scan keys on the DATA instead: any component that reaches
// for the AC-set vocabulary is a candidate, and a candidate that renders a
// denominator over that set must go through the shared helper.
//
// TWO LAYERS, both machine-checked:
//
//   1. Candidate  = a non-test .tsx under src/ mentioning AcWithVerification,
//                   AcHealth, acHealth, acs.total or acs.covered.
//   2. A candidate that RENDERS A DENOMINATOR must reference the shared helper
//      (`supersededCountLabel` / `supersededSuffix`).
//      A candidate that renders none is a pass-through — it must be listed in
//      PASS_THROUGH, AND the scan re-derives that it renders no denominator. An
//      exemption cannot outlive the reason for it: the day a pass-through starts
//      rendering coverage, its own entry is what fails.
//
// The exemption list is therefore not an allowlist for lying. It says "this file
// handles AC data but shows no coverage figure", and that claim is verified on
// every run rather than trusted.
//
// Comments are stripped before matching. The denominator patterns are prose-like
// ("{n} ACs", "{n} of"), and two pass-through files discuss ref interpolation
// like `{namespace}/{memex}/{handle}` in comments — matching those would make
// the scan fail for a reason that has nothing to do with coverage.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tagAc } from '@memex-ai-ac/vitest';

const SPEC = 'mindset-prod/memex-building-itself/specs/spec-566';
const acRef = (n: number) => `${SPEC}/acs/ac-${n}`;

const SRC = join(__dirname);

/** The vocabulary that says "this file handles the AC set". */
const AC_DATA = /\bAcWithVerification\b|\bAcHealth\b|\bacHealth\b|\bacs\.(total|covered)\b/;

/** The shapes a coverage denominator actually takes in this codebase. */
const DENOMINATOR = [
  // `AcHealth.totalActive` — the aggregate denominator (SpecHealthIndicator,
  // AcCells, SpecRefCard).
  /\btotalActive\b/,
  // The analytics strip's own denominator.
  /\bacs\.(total|covered)\b/,
  // "{n} AC" / "{n} ACs" — a count rendered immediately before the noun
  // (AcAboutDialog, DoneSummary, DecisionAcStrip).
  /\}\s*ACs?\b/,
  // "{covered.length} of {total}" — the AcPanel caption shape.
  /\.length\}\s+of\s/,
];

/**
 * The one decision every denominator-rendering surface must route through.
 *
 * It matches the IMPORT, not the bare identifier. A mutation probe is why: with
 * the identifier alone, replacing
 *
 *     import { supersededCountLabel } from '@memex/shared';
 *
 * with a local `const supersededCountLabel = () => null` left this scan GREEN —
 * the count silently vanished from the surface and the guard could not tell.
 * Requiring the import means the shared decision is the only way to satisfy it.
 * The `[^}]*` spans a multi-line brace list, so a grouped import still matches.
 */
const SHARED_HELPER =
  /import\s*\{[^}]*\b(supersededCountLabel|supersededSuffix)\b[^}]*\}\s*from\s*['"]@memex\/shared['"]/;

/**
 * Files that handle AC data but render no coverage figure of their own.
 *
 * Each entry is a CLAIM the scan re-checks below, not a waiver:
 *   AcPill                 — one AC's pill; a state, never a ratio.
 *   DecisionPanel          — hands rows to DecisionAcStrip, which renders it.
 *   HotSpecs               — hands health to AcCells, which renders it.
 *   KanbanColumn           — hands health to SpecHealthChip / SpecHealthStrip,
 *                            which render it.
 *   SpecRefStatusProvider  — names `acHealth` in a fetch `include` list.
 *   SpecList               — same; names `acHealth` when asking for it.
 *   DocDocument / Pulse    — pages that fetch and distribute; no figure of
 *                            their own.
 */
const PASS_THROUGH = [
  'components/AcPill.tsx',
  'components/DecisionPanel.tsx',
  'components/pulse/HotSpecs.tsx',
  'components/spec-board/KanbanColumn.tsx',
  'components/specRef/SpecRefStatusProvider.tsx',
  'pages/DocDocument.tsx',
  'pages/Pulse.tsx',
  'pages/SpecList.tsx',
];

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (name.endsWith('.tsx') && !name.includes('.test.')) {
      out.push(full);
    }
  }
  return out;
}

interface Candidate {
  path: string;
  body: string;
  rendersDenominator: boolean;
}

const candidates: Candidate[] = walk(SRC)
  .map((full) => ({ full, body: stripComments(readFileSync(full, 'utf-8')) }))
  .filter(({ body }) => AC_DATA.test(body))
  .map(({ full, body }) => ({
    path: relative(SRC, full),
    body,
    rendersDenominator: DENOMINATOR.some((re) => re.test(body)),
  }))
  .sort((a, b) => a.path.localeCompare(b.path));

describe('spec-566 ac-11 — no coverage surface ships without the count', () => {
  // Vacuity guard. Every assertion below is a `for` over `candidates`; an empty
  // or shrunken list would make all of them pass while proving nothing. This
  // pins that the walk really found the AC-data files, and names the nine the
  // per-surface mounts cover so a silent disappearance is a failure here.
  it('finds the AC-data components, including all nine known coverage surfaces', () => {
    tagAc(acRef(11));

    expect(candidates.length).toBeGreaterThanOrEqual(13);

    const known = [
      'components/AcAboutDialog.tsx',
      'components/AcPanel.tsx',
      'components/DecisionAcStrip.tsx',
      'components/DoneSummary.tsx',
      'components/SpecHealthIndicator.tsx',
      'components/insights/SpecSummaryStrip.tsx',
      'components/pulse/AcCells.tsx',
      'components/specRef/SpecRefCard.tsx',
    ];
    const paths = candidates.map((c) => c.path);
    for (const k of known) expect(paths).toContain(k);

    // HotSpecs is the ninth surface and renders its number through AcCells, so
    // it is a candidate AND a pass-through — both facts asserted, not assumed.
    expect(paths).toContain('components/pulse/HotSpecs.tsx');
  });

  it('every candidate that renders a denominator routes through the shared helper', () => {
    tagAc(acRef(11));

    const offenders = candidates
      .filter((c) => c.rendersDenominator)
      .filter((c) => !SHARED_HELPER.test(c.body))
      .map((c) => c.path);

    expect(
      offenders,
      `These render an AC coverage denominator without the superseded count. ` +
        `Import supersededCountLabel (or supersededSuffix) from '@memex/shared' ` +
        `and render it beside the figure — spec-566 dec-2.`,
    ).toEqual([]);

    // The check above is only meaningful if something was actually in scope.
    expect(candidates.filter((c) => c.rendersDenominator).length).toBeGreaterThanOrEqual(8);
  });

  it('every pass-through really renders no denominator', () => {
    tagAc(acRef(11));

    const byPath = new Map(candidates.map((c) => [c.path, c]));

    for (const path of PASS_THROUGH) {
      const c = byPath.get(path);
      // A stale entry is a failure too — an exemption for a file that no longer
      // touches AC data is dead weight that hides the next real one.
      expect(c, `PASS_THROUGH names ${path}, which is not an AC-data component`).toBeDefined();
      expect(
        c!.rendersDenominator,
        `${path} is exempted as a pass-through but now renders a coverage ` +
          `denominator. Either render the superseded count beside it, or drop ` +
          `it from PASS_THROUGH.`,
      ).toBe(false);
    }
  });

  it('no candidate is silently neither — every one is covered or exempted', () => {
    tagAc(acRef(11));

    const unaccounted = candidates
      .filter((c) => !c.rendersDenominator)
      .filter((c) => !PASS_THROUGH.includes(c.path))
      .filter((c) => !SHARED_HELPER.test(c.body))
      .map((c) => c.path);

    expect(
      unaccounted,
      `These handle AC data, render no denominator the scan can see, and are ` +
        `not declared as pass-throughs. Either they render coverage in a shape ` +
        `DENOMINATOR does not recognise — in which case teach the scan that ` +
        `shape — or add them to PASS_THROUGH with a one-line reason.`,
    ).toEqual([]);
  });
});
