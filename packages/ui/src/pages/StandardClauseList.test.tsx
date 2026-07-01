// spec-151 (ac-2) + spec-437 (dec-4 ac-2/ac-9/ac-10) — the standard renders ONCE as its
// clause list: one line per clause carrying a verification dot (passing / failing /
// untested, and no dot for a non-testable clause) plus its facet keys inline like
// citation markers. No duplicated prose, no coverage shelf, no archetype column. Drives
// the pure StandardClauseList with fixtures (no network, no markdown decision refs).

import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { StandardClauseList } from './Standard';
import type { ClauseWithVerification, ClauseCoverageState } from '../api/clause-coverage';

const AC151 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-151/acs/ac-${n}`;
const AC437 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-437/acs/ac-${n}`;

function clause(
  seq: number,
  state: ClauseCoverageState,
  over: Partial<{ countable: boolean; facetKeys: string[]; body: string; archetype: string | null }> = {},
): ClauseWithVerification {
  return {
    clause: {
      id: `id-${seq}`,
      seq,
      sectionId: 's1',
      body: over.body ?? `clause ${seq} body`,
      isObligation: true,
      testable: over.countable === false ? false : true,
      archetype: over.archetype ?? 'static-scan',
    },
    canonicalRef: `ns/mx/standards/std-1/clauses/cl-${seq}`,
    tests: [],
    state,
    countable: over.countable ?? true,
    daysSinceLastRun: null,
    facetKeys: over.facetKeys ?? [],
  };
}

describe('StandardClauseList — the unified clause render', () => {
  it('shows one verification dot per clause: passing / failing / untested [ac-2]', () => {
    tagAc(AC151(2));
    const clauses = [
      clause(1, 'passing'),
      clause(2, 'failing'),
      clause(3, 'untested'),
    ];
    render(<StandardClauseList clauses={clauses} parentDocId="doc-1" />);
    const dotState = (seq: number) =>
      within(screen.getByTestId(`clause-row-cl-${seq}`))
        .getByTestId('clause-status')
        .getAttribute('data-state');
    expect(dotState(1)).toBe('passing');
    expect(dotState(2)).toBe('failing');
    expect(dotState(3)).toBe('untested');
  });

  it('renders NO dot for a non-testable clause [ac-2]', () => {
    tagAc(AC151(2));
    render(
      <StandardClauseList
        clauses={[clause(1, 'untested', { countable: false })]}
        parentDocId="doc-1"
      />,
    );
    const dot = within(screen.getByTestId('clause-row-cl-1')).getByTestId('clause-status');
    // A non-testable clause carries the "none" marker (an invisible spacer), never a
    // passing/failing/untested glyph.
    expect(dot.getAttribute('data-state')).toBe('none');
  });

  it('renders facet keys inline per clause; a governs-nothing clause shows none [ac-2][ac-9][ac-10]', () => {
    tagAc(AC437(2));
    tagAc(AC437(9));
    tagAc(AC437(10));
    render(
      <StandardClauseList
        clauses={[
          clause(1, 'passing', { facetKeys: ['security', 'api-design'] }),
          clause(2, 'untested', { facetKeys: [] }),
        ]}
        parentDocId="doc-1"
      />,
    );
    const row1 = screen.getByTestId('clause-row-cl-1');
    const pills = within(row1).getAllByTestId('facet-pill').map((p) => p.getAttribute('data-facet-key'));
    expect(pills).toEqual(['security', 'api-design']);
    // A deliberate governs-nothing clause ([]) shows no facet pills.
    const row2 = screen.getByTestId('clause-row-cl-2');
    expect(within(row2).queryByTestId('facet-pill')).toBeNull();
  });

  it('does NOT render the testing archetype (plumbing, not reader-facing)', () => {
    render(
      <StandardClauseList
        clauses={[clause(1, 'passing', { archetype: 'grep-denylist' })]}
        parentDocId="doc-1"
      />,
    );
    expect(screen.queryByText('grep-denylist')).toBeNull();
  });
});
