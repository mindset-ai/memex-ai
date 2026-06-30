// spec-151 t-7 (ac-2, ac-13) — the Standard clause-coverage view renders which
// clauses are covered + their latest-green state (ac-2), and surfaces CI-backed
// green DISTINCTLY from local-only passing (ac-13). Drives the pure view directly
// with fixtures (no network).

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
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
  over: Partial<ClauseWithVerification['clause']> & { countable?: boolean; ciBacked?: boolean } = {},
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
    ciBacked: over.ciBacked ?? state === 'verified',
    countable,
    daysSinceLastRun: state === 'untested' ? null : 0,
  };
}

const coverage: StandardClauseCoverage = {
  clauses: [
    clause(1, 'verified'),
    clause(2, 'local', { ciBacked: false }),
    clause(3, 'failing'),
    clause(4, 'untested'),
    clause(5, 'untested', { isObligation: false, testable: false, countable: false }),
  ],
  countableTotal: 4,
  coveredCount: 3,
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
    expect(summary).toContain('1/4 testable obligations CI-verified');
    expect(summary).toContain('3/4 covered');
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
