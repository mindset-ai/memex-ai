import { describe, it, expect } from 'vitest';
import { tagAc } from "@memex-ai-ac/vitest";
import {
  blockerLines,
  computeSpecReadiness,
  countStaleDecisions,
  countUnresolvedDecisions,
  isBackwardTransition,
  isForwardTransition,
  isSpecNarrativeStale,
  shouldBlockForwardTransition,
  type DecisionForReadiness,
  type SpecPhase,
} from './spec-readiness.js';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-112/acs/ac-${n}`;

const dec = (overrides: Partial<DecisionForReadiness> = {}): DecisionForReadiness => {
  const resolvedAt = overrides.resolvedAt ?? null;
  // Default status from resolvedAt: a row with a resolvedAt timestamp is
  // implicitly resolved unless the test asks for something else (candidate /
  // rejected). This keeps the older tests — which only thought in terms of
  // resolvedAt — working after status became the source of truth for the
  // unresolved-decisions check.
  const status = overrides.status ?? (resolvedAt ? 'resolved' : 'open');
  return {
    id: overrides.id ?? 'd-1',
    createdAt: overrides.createdAt ?? '2026-05-01T00:00:00Z',
    resolvedAt,
    status,
  };
};

describe('isForwardTransition / isBackwardTransition', () => {
  const cases: [SpecPhase, SpecPhase, 'forward' | 'backward' | 'same'][] = [
    ['draft', 'plan', 'forward'],
    ['plan', 'build', 'forward'],
    ['build', 'verify', 'forward'],
    ['verify', 'done', 'forward'],
    ['draft', 'done', 'forward'],
    ['plan', 'draft', 'backward'],
    ['done', 'verify', 'backward'],
    ['build', 'plan', 'backward'],
    ['build', 'build', 'same'],
    ['draft', 'draft', 'same'],
  ];
  for (const [from, to, expected] of cases) {
    it(`${from} → ${to} is ${expected}`, () => {
      expect(isForwardTransition(from, to)).toBe(expected === 'forward');
      expect(isBackwardTransition(from, to)).toBe(expected === 'backward');
    });
  }
});

describe('countStaleDecisions / isSpecNarrativeStale', () => {
  it('returns 0 when there are no decisions (even if never consolidated)', () => {
    expect(countStaleDecisions(null, [])).toBe(0);
    expect(isSpecNarrativeStale(null, [])).toBe(false);
  });

  it('treats every existing decision as stale when never consolidated', () => {
    const decisions = [dec({ id: 'a' }), dec({ id: 'b' })];
    expect(countStaleDecisions(null, decisions)).toBe(2);
    expect(countStaleDecisions(undefined, decisions)).toBe(2);
    expect(isSpecNarrativeStale(null, decisions)).toBe(true);
  });

  it('treats decisions touched after consolidation as stale', () => {
    const decisions = [
      dec({ id: 'a', createdAt: '2026-01-01T00:00:00Z' }),
      dec({ id: 'b', createdAt: '2026-06-01T00:00:00Z' }),
    ];
    expect(countStaleDecisions('2026-03-01T00:00:00Z', decisions)).toBe(1);
    expect(isSpecNarrativeStale('2026-03-01T00:00:00Z', decisions)).toBe(true);
  });

  it('uses max(createdAt, resolvedAt) — a recently resolved decision counts even if created earlier', () => {
    const decisions = [
      dec({ createdAt: '2026-01-01T00:00:00Z', resolvedAt: '2026-06-01T00:00:00Z' }),
    ];
    expect(countStaleDecisions('2026-03-01T00:00:00Z', decisions)).toBe(1);
  });

  it('returns 0 / false when every decision pre-dates consolidation', () => {
    const decisions = [
      dec({ createdAt: '2025-01-01T00:00:00Z', resolvedAt: '2025-06-01T00:00:00Z' }),
    ];
    expect(countStaleDecisions('2026-03-01T00:00:00Z', decisions)).toBe(0);
    expect(isSpecNarrativeStale('2026-03-01T00:00:00Z', decisions)).toBe(false);
  });

  it('accepts Date inputs as well as ISO strings', () => {
    const decisions = [dec({ createdAt: new Date('2026-06-01T00:00:00Z') })];
    expect(
      countStaleDecisions(new Date('2026-01-01T00:00:00Z'), decisions),
    ).toBe(1);
  });
});

describe('countUnresolvedDecisions', () => {
  // Bug repro (May 2026): the readiness check should only flag decisions whose
  // status is 'open'. Earlier behaviour read `resolvedAt` and incorrectly
  // counted `candidate` decisions (status='candidate', resolvedAt=null), and
  // would also leak through any resolved/rejected row that ever shipped without
  // a populated resolvedAt. The function must look at status, not the
  // timestamp.

  it('counts only decisions with status open', () => {
    const decisions: DecisionForReadiness[] = [
      dec({ id: 'a', status: 'open', resolvedAt: null }),
      dec({ id: 'b', status: 'open', resolvedAt: null }),
    ];
    expect(countUnresolvedDecisions(decisions)).toBe(2);
  });

  it('does NOT count candidate decisions even though resolvedAt is null', () => {
    const decisions: DecisionForReadiness[] = [
      dec({ id: 'a', status: 'candidate', resolvedAt: null }),
      dec({ id: 'b', status: 'candidate', resolvedAt: null }),
    ];
    expect(countUnresolvedDecisions(decisions)).toBe(0);
  });

  it('does NOT count resolved decisions, even if resolvedAt happens to be null (data drift)', () => {
    const decisions: DecisionForReadiness[] = [
      dec({ id: 'a', status: 'resolved', resolvedAt: '2026-06-01T00:00:00Z' }),
      // Hypothetical drift: a resolved decision with no resolvedAt. The status
      // field is the source of truth — this row must not be counted.
      dec({ id: 'b', status: 'resolved', resolvedAt: null }),
    ];
    expect(countUnresolvedDecisions(decisions)).toBe(0);
  });

  it('does NOT count rejected decisions, even if resolvedAt happens to be null', () => {
    const decisions: DecisionForReadiness[] = [
      dec({ id: 'a', status: 'rejected', resolvedAt: '2026-06-01T00:00:00Z' }),
      dec({ id: 'b', status: 'rejected', resolvedAt: null }),
    ];
    expect(countUnresolvedDecisions(decisions)).toBe(0);
  });

  it('counts a mix correctly — open only', () => {
    const decisions: DecisionForReadiness[] = [
      dec({ id: 'a', status: 'open', resolvedAt: null }),
      dec({ id: 'b', status: 'candidate', resolvedAt: null }),
      dec({ id: 'c', status: 'resolved', resolvedAt: '2026-06-01T00:00:00Z' }),
      dec({ id: 'd', status: 'rejected', resolvedAt: '2026-06-02T00:00:00Z' }),
    ];
    expect(countUnresolvedDecisions(decisions)).toBe(1);
  });
});

describe('computeSpecReadiness — phase transition gate respects decision status', () => {
  // Bug repro (May 2026): plan→build dialog must not surface "unresolved
  // decisions" when every decision has been resolved. Earlier the gate read
  // `!resolvedAt` and would flag candidates / data-drifted rows.

  const consolidated = '2026-04-01T00:00:00Z';

  it('does not flag unresolved_decisions when every decision is resolved', () => {
    const r = computeSpecReadiness({
      currentPhase: 'plan',
      decisions: [
        dec({
          id: 'a',
          status: 'resolved',
          createdAt: '2026-05-01T00:00:00Z',
          resolvedAt: '2026-05-02T00:00:00Z',
        }),
        dec({
          id: 'b',
          status: 'resolved',
          createdAt: '2026-05-03T00:00:00Z',
          resolvedAt: '2026-05-04T00:00:00Z',
        }),
      ],
      openCommentCount: 0,
      narrativeLastConsolidatedAt: '2099-01-01T00:00:00Z',
    });
    expect(
      r.outstandingItems.find((i) => i.kind === 'unresolved_decisions'),
    ).toBeUndefined();
  });

  it('does not flag unresolved_decisions when every decision is a candidate', () => {
    const r = computeSpecReadiness({
      currentPhase: 'plan',
      decisions: [
        dec({ id: 'a', status: 'candidate', resolvedAt: null }),
        dec({ id: 'b', status: 'candidate', resolvedAt: null }),
      ],
      openCommentCount: 0,
      narrativeLastConsolidatedAt: '2099-01-01T00:00:00Z',
    });
    expect(
      r.outstandingItems.find((i) => i.kind === 'unresolved_decisions'),
    ).toBeUndefined();
  });

  it('flags unresolved_decisions only for the open ones in a mixed bag', () => {
    const r = computeSpecReadiness({
      currentPhase: 'plan',
      decisions: [
        dec({ id: 'a', status: 'open', resolvedAt: null }),
        dec({ id: 'b', status: 'candidate', resolvedAt: null }),
        dec({ id: 'c', status: 'resolved', resolvedAt: '2026-05-04T00:00:00Z' }),
      ],
      openCommentCount: 0,
      narrativeLastConsolidatedAt: '2099-01-01T00:00:00Z',
    });
    const item = r.outstandingItems.find((i) => i.kind === 'unresolved_decisions');
    expect(item).toMatchObject({ kind: 'unresolved_decisions', count: 1 });
  });

  it('does not block plan→build forward transition when only resolved decisions exist', () => {
    const r = computeSpecReadiness({
      currentPhase: 'plan',
      decisions: [
        dec({
          id: 'a',
          status: 'resolved',
          createdAt: '2026-05-01T00:00:00Z',
          resolvedAt: '2026-05-02T00:00:00Z',
        }),
      ],
      openCommentCount: 0,
      // Consolidate after the decision was resolved, so stale_narrative is also
      // clean — this isolates the unresolved_decisions check.
      narrativeLastConsolidatedAt: '2026-05-03T00:00:00Z',
    });
    expect(r.isClean).toBe(true);
    expect(shouldBlockForwardTransition(r, 'plan', 'build')).toBe(false);
  });
});

describe('computeSpecReadiness', () => {
  const consolidated = '2026-04-01T00:00:00Z';

  it('returns clean state for empty inputs', () => {
    const r = computeSpecReadiness({
      currentPhase: 'plan',
      decisions: [],
      openCommentCount: 0,
      narrativeLastConsolidatedAt: consolidated,
    });
    expect(r.isClean).toBe(true);
    expect(r.outstandingItems).toEqual([]);
  });

  it('flags only comments when nothing else is outstanding', () => {
    const r = computeSpecReadiness({
      currentPhase: 'build',
      decisions: [],
      openCommentCount: 4,
      narrativeLastConsolidatedAt: consolidated,
    });
    expect(r.isClean).toBe(false);
    expect(r.outstandingItems).toHaveLength(1);
    expect(r.outstandingItems[0]).toMatchObject({
      kind: 'unresolved_comments',
      count: 4,
      label: '4 open comments',
    });
    expect(r.outstandingItems[0].cta).toContain('Resolve Comments');
  });

  it('uses singular "open comment" when count is 1', () => {
    const r = computeSpecReadiness({
      currentPhase: 'build',
      decisions: [],
      openCommentCount: 1,
      narrativeLastConsolidatedAt: consolidated,
    });
    expect(r.outstandingItems[0].label).toBe('1 open comment');
  });

  it('flags only stale narrative when comments are clean and decisions are resolved', () => {
    const r = computeSpecReadiness({
      currentPhase: 'build',
      decisions: [
        dec({ id: 'a', createdAt: '2026-06-01T00:00:00Z', resolvedAt: '2026-06-02T00:00:00Z' }),
        dec({ id: 'b', createdAt: '2026-07-01T00:00:00Z', resolvedAt: '2026-07-02T00:00:00Z' }),
      ],
      openCommentCount: 0,
      narrativeLastConsolidatedAt: consolidated,
    });
    expect(r.isClean).toBe(false);
    expect(r.outstandingItems).toHaveLength(1);
    expect(r.outstandingItems[0]).toMatchObject({
      kind: 'stale_narrative',
      staleDecisionCount: 2,
      label: '2 decisions not yet reflected in the narrative',
    });
    expect(r.outstandingItems[0].cta).toContain('New decisions — update narrative');
  });

  it('uses singular "decision" when only one is stale', () => {
    const r = computeSpecReadiness({
      currentPhase: 'build',
      decisions: [dec({ createdAt: '2026-06-01T00:00:00Z', resolvedAt: '2026-06-02T00:00:00Z' })],
      openCommentCount: 0,
      narrativeLastConsolidatedAt: consolidated,
    });
    expect(r.outstandingItems[0].label).toBe(
      '1 decision not yet reflected in the narrative',
    );
  });

  it('flags unresolved decisions before stale narrative and comments', () => {
    const r = computeSpecReadiness({
      currentPhase: 'plan',
      decisions: [
        dec({ id: 'a', createdAt: '2026-07-01T00:00:00Z', resolvedAt: null }),
        dec({ id: 'b', createdAt: '2026-06-01T00:00:00Z', resolvedAt: '2026-06-02T00:00:00Z' }),
      ],
      openCommentCount: 1,
      narrativeLastConsolidatedAt: consolidated,
    });
    expect(r.isClean).toBe(false);
    expect(r.outstandingItems.map((i) => i.kind)).toEqual([
      'unresolved_decisions',
      'unresolved_comments',
      'stale_narrative',
    ]);
    const decisionItem = r.outstandingItems[0];
    expect(decisionItem).toMatchObject({
      kind: 'unresolved_decisions',
      count: 1,
      label: '1 unresolved decision',
    });
    expect(decisionItem.cta).toContain('Decisions tab');
  });

  it('uses plural "unresolved decisions" when more than one is open', () => {
    const r = computeSpecReadiness({
      currentPhase: 'plan',
      decisions: [
        dec({ id: 'a', resolvedAt: null }),
        dec({ id: 'b', resolvedAt: null }),
        dec({ id: 'c', resolvedAt: null }),
      ],
      openCommentCount: 0,
      narrativeLastConsolidatedAt: '2099-01-01T00:00:00Z',
    });
    expect(r.outstandingItems.find((i) => i.kind === 'unresolved_decisions')).toMatchObject({
      label: '3 unresolved decisions',
    });
  });

  it('flags comments + stale narrative when decisions are all resolved', () => {
    const r = computeSpecReadiness({
      currentPhase: 'verify',
      decisions: [dec({ createdAt: '2026-07-01T00:00:00Z', resolvedAt: '2026-07-02T00:00:00Z' })],
      openCommentCount: 3,
      narrativeLastConsolidatedAt: consolidated,
    });
    expect(r.isClean).toBe(false);
    expect(r.outstandingItems.map((i) => i.kind)).toEqual([
      'unresolved_comments',
      'stale_narrative',
    ]);
  });

  it('treats never-consolidated Spec as stale when it has decisions (and unresolved if not yet resolved)', () => {
    const r = computeSpecReadiness({
      currentPhase: 'plan',
      decisions: [dec()],
      openCommentCount: 0,
      narrativeLastConsolidatedAt: null,
    });
    expect(r.isClean).toBe(false);
    // Default `dec()` is unresolved — both kinds should fire.
    expect(r.outstandingItems.map((i) => i.kind)).toEqual([
      'unresolved_decisions',
      'stale_narrative',
    ]);
  });

  it('never-consolidated Spec with no decisions stays clean', () => {
    const r = computeSpecReadiness({
      currentPhase: 'draft',
      decisions: [],
      openCommentCount: 0,
      narrativeLastConsolidatedAt: null,
    });
    expect(r.isClean).toBe(true);
  });
});

describe('computeSpecReadiness — open/converted Issues at the verify→done gate (spec-112 t-8)', () => {
  const consolidated = '2026-04-01T00:00:00Z';

  // Baseline inputs with NOTHING else outstanding, so the issue item is isolated.
  const clean = (openIssueCount?: number) =>
    computeSpecReadiness({
      currentPhase: 'verify',
      decisions: [],
      openCommentCount: 0,
      narrativeLastConsolidatedAt: consolidated,
      openIssueCount,
    });

  it('flags open/converted Issues in verify, naming the count (ac-17)', () => {
    tagAc(AC(17));
    const r = clean(3);
    const item = r.outstandingItems.find((i) => i.kind === 'open_issues');
    expect(item).toMatchObject({
      kind: 'open_issues',
      count: 3,
      label: '3 open or converted Issues',
    });
    // The count is named in the human-readable line.
    expect(blockerLines(r).some((l) => l.includes('3 open or converted Issues'))).toBe(true);
  });

  it('uses singular wording for a single open/converted Issue (ac-17)', () => {
    tagAc(AC(17));
    const item = clean(1).outstandingItems.find((i) => i.kind === 'open_issues');
    expect(item?.label).toBe('1 open or converted Issue');
  });

  it('emits NO issue item when count is 0 — all resolved/wont_fix or none (ac-17)', () => {
    tagAc(AC(17));
    expect(clean(0).outstandingItems.find((i) => i.kind === 'open_issues')).toBeUndefined();
    // Omitting openIssueCount entirely is the same as 0.
    expect(clean(undefined).outstandingItems.find((i) => i.kind === 'open_issues')).toBeUndefined();
  });

  it('does not fire outside verify — earlier gates never carry the issue item (ac-17)', () => {
    tagAc(AC(17));
    for (const phase of ['draft', 'plan', 'build'] as SpecPhase[]) {
      const r = computeSpecReadiness({
        currentPhase: phase,
        decisions: [],
        openCommentCount: 0,
        narrativeLastConsolidatedAt: consolidated,
        openIssueCount: 5,
      });
      expect(r.outstandingItems.find((i) => i.kind === 'open_issues')).toBeUndefined();
    }
  });

  it('the issue item is SOFT — it never escalates to a hard forward-transition block beyond the existing isClean contract (ac-18)', () => {
    tagAc(AC(18));
    // The shared layer never blocks `done` itself — gating is a surface concern,
    // and the server keeps update_doc({status:'done'}) succeeding regardless. Here
    // we assert the issue item participates in `outstandingItems` (a warning) and
    // is the ONLY thing dirtying the readiness, proving it's a pure soft signal
    // with no other coupled blocker.
    const r = clean(2);
    expect(r.outstandingItems.map((i) => i.kind)).toEqual(['open_issues']);
  });
});

describe('shouldBlockForwardTransition', () => {
  const consolidated = '2026-04-01T00:00:00Z';

  it('blocks forward + dirty', () => {
    const r = computeSpecReadiness({
      currentPhase: 'plan',
      decisions: [],
      openCommentCount: 2,
      narrativeLastConsolidatedAt: consolidated,
    });
    expect(shouldBlockForwardTransition(r, 'plan', 'build')).toBe(true);
  });

  it('does not block forward + clean', () => {
    const r = computeSpecReadiness({
      currentPhase: 'plan',
      decisions: [],
      openCommentCount: 0,
      narrativeLastConsolidatedAt: consolidated,
    });
    expect(shouldBlockForwardTransition(r, 'plan', 'build')).toBe(false);
  });

  it('does not block backward transitions even when dirty', () => {
    const r = computeSpecReadiness({
      currentPhase: 'build',
      decisions: [],
      openCommentCount: 5,
      narrativeLastConsolidatedAt: consolidated,
    });
    expect(shouldBlockForwardTransition(r, 'build', 'plan')).toBe(false);
  });

  it('does not block same-phase no-op even when dirty', () => {
    const r = computeSpecReadiness({
      currentPhase: 'build',
      decisions: [],
      openCommentCount: 5,
      narrativeLastConsolidatedAt: consolidated,
    });
    expect(shouldBlockForwardTransition(r, 'build', 'build')).toBe(false);
  });
});

describe('blockerLines', () => {
  it('returns empty when clean', () => {
    expect(
      blockerLines(
        computeSpecReadiness({
          currentPhase: 'plan',
          decisions: [],
          openCommentCount: 0,
          narrativeLastConsolidatedAt: null,
        }),
      ),
    ).toEqual([]);
  });

  it('formats comment + narrative lines as label — cta when decisions are resolved', () => {
    const r = computeSpecReadiness({
      currentPhase: 'verify',
      decisions: [
        dec({ id: 'a', createdAt: '2026-07-01T00:00:00Z', resolvedAt: '2026-07-02T00:00:00Z' }),
        dec({ id: 'b', createdAt: '2026-07-02T00:00:00Z', resolvedAt: '2026-07-03T00:00:00Z' }),
        dec({ id: 'c', createdAt: '2026-07-03T00:00:00Z', resolvedAt: '2026-07-04T00:00:00Z' }),
      ],
      openCommentCount: 1,
      narrativeLastConsolidatedAt: '2026-04-01T00:00:00Z',
    });
    const lines = blockerLines(r);
    expect(lines).toEqual([
      '1 open comment — Use the "Resolve Comments" button to walk them with the agent.',
      '3 decisions not yet reflected in the narrative — Use the "New decisions — update narrative" button to consolidate.',
    ]);
  });

  it('includes unresolved-decision line when decisions are still open', () => {
    const r = computeSpecReadiness({
      currentPhase: 'plan',
      decisions: [dec({ id: 'a', resolvedAt: null }), dec({ id: 'b', resolvedAt: null })],
      openCommentCount: 0,
      narrativeLastConsolidatedAt: '2099-01-01T00:00:00Z',
    });
    const lines = blockerLines(r);
    expect(lines).toEqual([
      '2 unresolved decisions — Resolve them on the Decisions tab — tasks are first-class only once decisions are settled.',
    ]);
  });
});
