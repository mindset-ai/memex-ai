// spec-566 t-8 (dec-9) — the reopen count, on the same seats as the other two.
//
// dec-9 froze a closed Spec's criteria and named reopening as the way back in.
// The count is what stops that way back in becoming the quiet route around the
// freeze: reopen, edit what the Spec had certified, close again, and without a
// visible count nothing on any surface says it happened.
//
// THE POINT OF THE THIRD NUMBER IS THAT IT COST NOTHING. t-5 shipped one count
// and t-7 a second, and the second time the labels moved into one shared
// function (`coverageAnnotationLabels`) precisely so a third would not mean
// editing nine files again. `reopenCountLabel` was written then, rendering
// nothing until t-8 gave it data. These cases check that the plumbing — not a
// new vocabulary — is all that landed.

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';

import { SpecHealthChip } from './SpecHealthIndicator';
import { AcCells } from './pulse/AcCells';
import { SpecRefCard } from './specRef/SpecRefCard';
import { SpecSummaryStrip } from './insights/SpecSummaryStrip';
import { DoneSummary } from './DoneSummary';
import { DecisionAcStrip } from './DecisionAcStrip';
import type { AcWithVerification } from '../api/client';
import type { AcHealth, DocSummary, DocWithGraph } from '../api/types';
import type { SpecLifecycleSummary } from '../api/insights';

const SPEC = 'mindset-prod/memex-building-itself/specs/spec-566';
const acRef = (n: number) => `${SPEC}/acs/ac-${n}`;

const HEALTH: AcHealth = {
  totalActive: 2,
  covered: 2,
  verified: 2,
  failing: 0,
  stale: 0,
  untested: 0,
  accepted: 0,
  superseded: 0,
  overrides: 0,
  reopens: 0,
};

function makeAc(seq: number, decisionId?: string): AcWithVerification {
  return {
    ac: {
      id: `ac-uuid-${seq}`,
      memexId: 'mx',
      briefId: 'doc-uuid',
      seq,
      kind: 'implementation',
      statement: `Criterion ${seq}`,
      status: 'active',
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
    },
    canonicalRef: acRef(seq),
    tests: [
      { testIdentifier: `t-${seq}`, latestStatus: 'pass', runCount: 1, latestRunAt: '2026-09-15T00:00:00Z' },
    ] as unknown as AcWithVerification['tests'],
    verificationState: 'verified',
    daysSinceLastRun: 1,
    parents: decisionId ? [{ kind: 'decision', id: decisionId, seq: 1, title: 'D' }] : [],
  } as unknown as AcWithVerification;
}
const ROWS = [makeAc(1), makeAc(2)];

function makeDocSummary(health: AcHealth): DocSummary {
  return {
    id: 'id-1',
    handle: 'spec-566',
    title: 'A criterion cannot be rewritten in silence',
    docType: 'spec',
    status: 'verify',
    parentDocId: null,
    createdAt: '2026-09-01T10:00:00Z',
    statusChangedAt: '2026-09-10T10:00:00Z',
    sectionCount: 4,
    archivedAt: null,
    taskProgress: { total: 8, complete: 4, inProgress: 1, notStarted: 3 },
    acHealth: health,
  } as unknown as DocSummary;
}

function makeDocWithGraph(reopens: number): DocWithGraph {
  return {
    id: 'doc-uuid',
    handle: 'spec-566',
    title: 'A criterion cannot be rewritten in silence',
    docType: 'spec',
    status: 'done',
    creator: { name: 'A Maintainer', email: 'maintainer@example.test' },
    createdAt: '2026-09-01T12:00:00Z',
    statusChangedAt: '2026-09-15T12:00:00Z',
    sections: [],
    decisions: [],
    tasks: [],
    gateOverrides: 0,
    reopens,
  } as unknown as DocWithGraph;
}

describe('spec-566 t-8 — every coverage surface names the reopens', () => {
  it('SpecHealthChip', () => {
    tagAc(acRef(27));
    // Vacuity guard: at zero it says nothing, so the positive case below is
    // about the count and not an always-present string.
    const { unmount } = render(<SpecHealthChip health={HEALTH} />);
    expect(screen.getByTestId('spec-health-chip')).not.toHaveTextContent('reopen');
    unmount();

    render(<SpecHealthChip health={{ ...HEALTH, reopens: 2 }} />);
    expect(screen.getByTestId('spec-health-chip')).toHaveTextContent('2 reopens');
  });

  it('AcCells, in text and in the bar’s accessible name', () => {
    tagAc(acRef(27));
    render(<AcCells health={{ ...HEALTH, reopens: 2 }} />);
    expect(screen.getByTestId('ac-cells')).toHaveTextContent('2 reopens');
    expect(screen.getByRole('img')).toHaveAccessibleName(/2 reopens/);
  });

  it('SpecRefCard', () => {
    tagAc(acRef(27));
    render(<SpecRefCard id="id-1" doc={makeDocSummary({ ...HEALTH, reopens: 1 })} />);
    expect(screen.getByTestId('spec-ref-acs')).toHaveTextContent('1 reopen');
  });

  it('SpecSummaryStrip', () => {
    tagAc(acRef(27));
    const summary: SpecLifecycleSummary = {
      createdAt: '2026-09-01T10:00:00Z',
      currentPhase: 'verify',
      ageDays: 15,
      timeInCurrentPhaseDays: 5,
      tasks: { total: 8, complete: 4 },
      acs: { total: 2, verified: 2, failing: 0, covered: 2, superseded: 0, overrides: 0, reopens: 3 },
    };
    render(<SpecSummaryStrip summary={summary} />);
    expect(screen.getByTestId('spec-summary-strip')).toHaveTextContent('3 reopens');
  });

  it('DoneSummary, from the doc payload', () => {
    tagAc(acRef(27));
    // The Done screen is where this matters most: it is the record a reader
    // trusts, and a Spec reopened three times to rewrite what it certified
    // should not read identically to one closed once and left alone.
    render(
      <DoneSummary doc={makeDocWithGraph(1)} decisions={[]} tasks={[]} acs={ROWS} issues={[]} />,
    );
    expect(screen.getByTestId('done-superseded-count')).toHaveTextContent('1 reopen');
  });

  it('DecisionAcStrip, from the prop the panel supplies', () => {
    tagAc(acRef(27));
    render(
      <DecisionAcStrip
        acs={[makeAc(1, 'dec-1'), makeAc(2, 'dec-1')]}
        decisionId="dec-1"
        reopens={2}
      />,
    );
    expect(screen.getByTestId('decision-ac-strip-caption')).toHaveTextContent('2 reopens');
  });

  it('shows all three counts together, in a fixed order', () => {
    tagAc(acRef(27));
    // The compounding case — a Spec that retired a criterion, waved its gate
    // through AND was reopened is exactly the one a reader most needs the whole
    // picture of. A surface showing one and swallowing the others would pass
    // every single-count case above.
    render(<SpecHealthChip health={{ ...HEALTH, superseded: 1, overrides: 2, reopens: 3 }} />);
    expect(screen.getByTestId('spec-health-chip')).toHaveTextContent(
      '1 superseded · 2 gate overrides · 3 reopens',
    );
  });

  it('singularises one reopen', () => {
    tagAc(acRef(27));
    const chip = render(<SpecHealthChip health={{ ...HEALTH, reopens: 1 }} />).getByTestId(
      'spec-health-chip',
    );
    expect(chip).toHaveTextContent('1 reopen');
    expect(chip).not.toHaveTextContent('1 reopens');
  });
});
