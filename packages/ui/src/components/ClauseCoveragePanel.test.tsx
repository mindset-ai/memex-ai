// spec-151 t-7 (ac-2, ac-13) — the Standard clause-coverage view renders which
// clauses are covered + their latest-green state (ac-2), and surfaces CI-backed
// green DISTINCTLY from local-only passing (ac-13). Drives the pure view directly
// with fixtures (no network).

import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { ClauseCoverageView } from './ClauseCoveragePanel';
import type {
  StandardClauseCoverage,
  ClauseCoverageState,
  ClauseWithVerification,
} from '../api/clause-coverage';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-151/acs/ac-${n}`;

function clause(
  seq: number,
  state: ClauseCoverageState,
  over: Partial<ClauseWithVerification['clause']> & {
    countable?: boolean;
    ciBacked?: boolean;
    facetKeys?: string[];
  } = {},
): ClauseWithVerification {
  const countable = over.countable ?? true;
  return {
    clause: {
      id: `id-${seq}`,
      seq,
      body: `clause ${seq} body`,
      isObligation: over.isObligation ?? true,
      testable: over.testable ?? true,
      archetype: over.archetype ?? (over.testable === false ? null : 'static-scan'),
    },
    canonicalRef: `ns/mx/standards/std-1/clauses/cl-${seq}`,
    tests: state === 'untested' ? [] : [
      { testIdentifier: `t::cl-${seq}`, latestStatus: state === 'failing' ? 'fail' : 'pass', latestRunAt: new Date().toISOString(), runCount: 1 },
    ],
    state,
    ciBacked: over.ciBacked ?? (state === 'verified' || state === 'spot'),
    sweptSurface: state === 'verified' ? 'whole-surface' : state === 'spot' ? 'spot' : null,
    checkKind: state === 'verified' || state === 'spot' ? 'grep-denylist' : null,
    wholeSurface: state === 'verified',
    countable,
    daysSinceLastRun: state === 'untested' ? null : 0,
    facetKeys: over.facetKeys ?? [],
  };
}

const coverage: StandardClauseCoverage = {
  clauses: [
    clause(1, 'verified'),
    clause(2, 'local', { ciBacked: false }),
    clause(3, 'failing'),
    clause(4, 'untested'),
    clause(5, 'untested', { isObligation: false, testable: false, countable: false }),
    clause(6, 'spot'), // CI-backed but a spot check → not universal (ac-8)
  ],
  countableTotal: 5,
  coveredCount: 4,
  verifiedCount: 1,
};

describe('ClauseCoverageView (spec-151 t-7)', () => {
  it('shows every clause with its latest-green coverage state, mirroring the AC matrix [ac-2]', () => {
    tagAc(AC(2));
    render(<ClauseCoverageView coverage={coverage} />);
    // All clauses are listed.
    for (const seq of [1, 2, 3, 4, 5]) {
      expect(screen.getByTestId(`clause-row-cl-${seq}`)).toBeTruthy();
    }
    // The summary surfaces the covered + CI-verified ratio over the testable-obligation
    // denominator.
    const summary = screen.getByTestId('clause-coverage-summary').textContent ?? '';
    expect(summary).toContain('1/5 testable obligations CI-verified');
    expect(summary).toContain('4/5 covered');
  });

  it('renders a spot-only (CI-backed but non-universal) clause distinctly from a verified one [ac-8]', () => {
    tagAc(AC(8));
    render(<ClauseCoverageView coverage={coverage} />);
    const spotBadge = screen.getByTestId('clause-badge-cl-6');
    const verifiedBadge = screen.getByTestId('clause-badge-cl-1');
    expect(spotBadge.textContent).toBe('spot-only');
    expect(spotBadge.textContent).not.toBe(verifiedBadge.textContent);
    expect(spotBadge.className).not.toBe(verifiedBadge.className);
    expect(screen.getByTestId('clause-row-cl-6').getAttribute('data-state')).toBe('spot');
  });

  it('surfaces CI-backed green DISTINCTLY from local-only passing [ac-13]', () => {
    tagAc(AC(13));
    render(<ClauseCoverageView coverage={coverage} />);
    const verifiedBadge = screen.getByTestId('clause-badge-cl-1');
    const localBadge = screen.getByTestId('clause-badge-cl-2');
    // Different label text...
    expect(verifiedBadge.textContent).toBe('CI-verified');
    expect(localBadge.textContent).toBe('local-only');
    expect(verifiedBadge.textContent).not.toBe(localBadge.textContent);
    // ...and a different visual treatment (distinct class), so a local pass never
    // reads as enforced-at-merge.
    expect(verifiedBadge.className).not.toBe(localBadge.className);
    // The row state attributes are distinct too.
    expect(screen.getByTestId('clause-row-cl-1').getAttribute('data-state')).toBe('verified');
    expect(screen.getByTestId('clause-row-cl-2').getAttribute('data-state')).toBe('local');
  });
});

describe('ClauseCoverageView — facets on the shared shelf (spec-437 dec-4)', () => {
  const AC437 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-437/acs/ac-${n}`;
  const withFacets: StandardClauseCoverage = {
    clauses: [
      clause(1, 'verified', { facetKeys: ['security', 'api-design'] }),
      clause(2, 'untested', { facetKeys: [] }), // a deliberate governs-nothing clause
    ],
    countableTotal: 2,
    coveredCount: 1,
    verifiedCount: 1,
  };

  it('renders the facets slot inline per clause, alongside the testability badge on one shelf (ac-2, ac-9, ac-10)', () => {
    tagAc(AC437(2)); // scope: every clause displays its facets inline on the Standards view
    tagAc(AC437(9));
    tagAc(AC437(10));
    render(<ClauseCoverageView coverage={withFacets} />);
    const row1 = screen.getByTestId('clause-row-cl-1');
    // facets slot: one pill per facet key, inline on the clause row.
    const pills = within(row1).getAllByTestId('facet-pill').map((p) => p.getAttribute('data-facet-key'));
    expect(pills).toEqual(['security', 'api-design']);
    // testability slot: 151's coverage badge sits on the SAME row — one generic shelf,
    // both metadata families (the reserved slot, now filled).
    expect(within(row1).getByTestId('clause-badge-cl-1')).toBeTruthy();
    // A deliberate governs-nothing clause ([]) shows no facet pills.
    const row2 = screen.getByTestId('clause-row-cl-2');
    expect(within(row2).queryByTestId('facet-pill')).toBeNull();
    expect(within(row2).getByTestId('clause-badge-cl-2')).toBeTruthy();
  });
});
