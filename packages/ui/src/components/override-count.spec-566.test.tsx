// spec-566 t-7 — the override count, beside coverage, on every surface the
// superseded count reaches.
//
//   ac-22  "The override count is rendered beside the Spec's coverage on the
//          same surfaces the superseded count appears on, so an overridden Spec
//          cannot present as clean. An override nobody can see becomes the
//          normal path, which is how this decision decays into the warning-only
//          option it rejected."
//
// THIS IS THE GUARD, NOT A DECORATION. dec-7 chose "block with a named override"
// over a plain block precisely because a gate with no recourse gets escaped in
// ways nobody records. The one thing keeping that choice from collapsing into
// the warning-only option it rejected is that overrides are counted and SHOWN.
// A count the server computes and no surface renders is the same as no count.
//
// TWO DATA SHAPES, ONE NUMBER. Five surfaces read `AcHealth.overrides`
// (SpecHealthIndicator, AcCells, HotSpecs transitively, SpecRefCard) or the
// analytics strip's own `acs.overrides`. The other four render from
// `AcWithVerification[]`, which is a list of CRITERIA and cannot carry a
// Spec-level act — they take it as a prop from the page, which reads it off the
// doc payload's `gateOverrides`. Both paths are asserted here; the prop path is
// the one that would silently render 0 for ever if the plumbing broke, because
// its default is 0 and nothing would look wrong.

import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';

import { AcPanel } from './AcPanel';
import { AcAboutDialog } from './AcAboutDialog';
import { SpecHealthChip } from './SpecHealthIndicator';
import { DoneSummary } from './DoneSummary';
import { DecisionAcStrip } from './DecisionAcStrip';
import { AcCells } from './pulse/AcCells';
import { HotSpecs } from './pulse/HotSpecs';
import { SpecRefCard } from './specRef/SpecRefCard';
import { SpecSummaryStrip } from './insights/SpecSummaryStrip';

import { fetchAcsForBrief, fetchAcAlignmentHistory } from '../api/client';
import type { AcWithVerification } from '../api/client';
import type { AcHealth, DocSummary, DocWithGraph } from '../api/types';
import type { SpecLifecycleSummary } from '../api/insights';
import type { ActivityRow } from './pulse/types';

const SPEC = 'mindset-prod/memex-building-itself/specs/spec-566';
const acRef = (n: number) => `${SPEC}/acs/ac-${n}`;

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return {
    ...actual,
    fetchAcsForBrief: vi.fn(),
    fetchAcAlignmentHistory: vi.fn(),
    fetchAcTestMatrix: vi.fn().mockResolvedValue([]),
    acceptAc: vi.fn().mockResolvedValue(undefined),
    unacceptAc: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock('./ChatContext', () => ({ useChat: () => ({ addContextChip: vi.fn() }) }));

beforeEach(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  vi.mocked(fetchAcAlignmentHistory).mockResolvedValue([]);
});

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
      {
        testIdentifier: `suite.test.ts::criterion ${seq}`,
        latestStatus: 'pass',
        runCount: 3,
        latestRunAt: '2026-09-15T00:00:00Z',
      },
    ] as unknown as AcWithVerification['tests'],
    verificationState: 'verified',
    daysSinceLastRun: 1,
    parents: decisionId ? [{ kind: 'decision', id: decisionId, seq: 1, title: 'D' }] : [],
  } as unknown as AcWithVerification;
}

const ROWS = [makeAc(1), makeAc(2)];
const ROWS_UNDER_DEC = [makeAc(1, 'dec-1'), makeAc(2, 'dec-1')];

/** Health with a clean criteria history and TWO overrides — the case ac-22 is about. */
const HEALTH_WITH_OVERRIDES: AcHealth = {
  totalActive: 2,
  covered: 2,
  verified: 2,
  failing: 0,
  stale: 0,
  untested: 0,
  accepted: 0,
  superseded: 0,
  overrides: 2,
  reopens: 0,
};
const HEALTH_CLEAN: AcHealth = { ...HEALTH_WITH_OVERRIDES, overrides: 0 };

// ──────────────────────────────────────────────────────────────────────────
// The five surfaces fed by AcHealth / the analytics strip.
// ──────────────────────────────────────────────────────────────────────────

describe('ac-22 — the AcHealth-fed surfaces', () => {
  it('SpecHealthChip renders the override count beside the ratio', () => {
    tagAc(acRef(22));
    // Vacuity guard: the same health with overrides 0 says nothing, so the
    // assertion below is about the count and not some always-present string.
    const { unmount } = render(<SpecHealthChip health={HEALTH_CLEAN} />);
    expect(screen.getByTestId('spec-health-chip')).not.toHaveTextContent('override');
    unmount();

    render(<SpecHealthChip health={HEALTH_WITH_OVERRIDES} />);
    const chip = screen.getByTestId('spec-health-chip');
    expect(chip).toHaveTextContent('2/2 verified');
    expect(chip).toHaveTextContent('2 gate overrides');
  });

  it('AcCells renders it, in text and in the bar’s accessible name', () => {
    tagAc(acRef(22));
    render(<AcCells health={HEALTH_WITH_OVERRIDES} />);
    expect(screen.getByTestId('ac-cells')).toHaveTextContent('2 gate overrides');
    expect(screen.getByRole('img')).toHaveAccessibleName(/2 gate overrides/);
  });

  it('HotSpecs carries it onto the card, through AcCells', () => {
    tagAc(acRef(22));
    const NOW = 1_700_000_000_000;
    const activity: ActivityRow = {
      id: 'a1',
      memexId: 'mx',
      briefId: 'doc-A',
      actorUserId: 'u1',
      actorName: null,
      actorKind: 'human',
      channel: 'rest_ui',
      clientId: null,
      entity: 'task',
      action: 'updated',
      narrative: 'did a thing',
      payload: null,
      createdAt: new Date(NOW - 10_000).toISOString(),
    };
    render(
      <MemoryRouter>
        <HotSpecs
          present={[]}
          activity={[activity]}
          now={NOW}
          specHandle={() => 'spec-566'}
          specTitle={() => 'Title'}
          specPhase={() => 'verify'}
          specNarrative={() => 'narrative'}
          specAcHealth={() => HEALTH_WITH_OVERRIDES}
          specHref={(h) => `/mindset-prod/memex-building-itself/specs/${h}`}
        />
      </MemoryRouter>,
    );
    const card = screen.getAllByTestId('hot-spec-card')[0];
    expect(within(card).getByTestId('ac-cells')).toHaveTextContent('2 gate overrides');
  });

  it('SpecRefCard names it beside the percentage', () => {
    tagAc(acRef(22));
    const doc = {
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
      acHealth: HEALTH_WITH_OVERRIDES,
    } as unknown as DocSummary;

    render(<SpecRefCard id="id-1" doc={doc} />);
    const line = screen.getByTestId('spec-ref-acs');
    // 100% AND two overrides on the same line — an overridden Spec cannot
    // present as clean, which is ac-22's sentence.
    expect(line).toHaveTextContent('100% of 2 acceptance criteria verified');
    expect(line).toHaveTextContent('2 gate overrides');
  });

  it('SpecSummaryStrip carries it in the sub-line', () => {
    tagAc(acRef(22));
    const summary: SpecLifecycleSummary = {
      createdAt: '2026-09-01T10:00:00Z',
      currentPhase: 'verify',
      ageDays: 15,
      timeInCurrentPhaseDays: 5,
      tasks: { total: 8, complete: 4 },
      acs: { total: 2, verified: 2, failing: 0, covered: 2, superseded: 0, overrides: 2, reopens: 0 },
    };
    render(<SpecSummaryStrip summary={summary} />);
    expect(screen.getByTestId('spec-summary-strip')).toHaveTextContent(
      '2/2 verified · 2 gate overrides',
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────
// The four surfaces fed by AC ROWS, which take the number as a prop.
//
// These are the ones worth testing hardest. Their default is 0, so broken
// plumbing renders a clean Spec and nothing anywhere looks wrong.
// ──────────────────────────────────────────────────────────────────────────

describe('ac-22 — the row-fed surfaces take it as a prop', () => {
  it('AcPanel renders it from the prop the page supplies', async () => {
    tagAc(acRef(22));
    vi.mocked(fetchAcsForBrief).mockResolvedValue(ROWS);

    // Vacuity guard on the DEFAULT. Without the prop the panel says nothing —
    // which is exactly what broken plumbing would produce, so the positive case
    // below is the only thing that distinguishes wired from unwired.
    const bare = render(<AcPanel docId="doc-uuid" />);
    const bareHeader = await bare.findByTestId('ac-unified-header');
    expect(bareHeader).not.toHaveTextContent('override');
    bare.unmount();

    render(<AcPanel docId="doc-uuid" gateOverrides={2} />);
    const header = await screen.findByTestId('ac-unified-header');
    expect(within(header).getByTestId('ac-superseded-count')).toHaveTextContent(
      '2 gate overrides',
    );
  });

  it('AcAboutDialog names it in its prose', () => {
    tagAc(acRef(22));
    render(<AcAboutDialog rows={ROWS} gateOverrides={1} onClose={() => {}} />);
    expect(screen.getByTestId('ac-about-superseded-count')).toHaveTextContent(
      '1 gate override',
    );
  });

  it('DoneSummary reads it off the doc payload', () => {
    tagAc(acRef(22));
    const doc = {
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
      gateOverrides: 1,
    } as unknown as DocWithGraph;

    render(<DoneSummary doc={doc} decisions={[]} tasks={[]} acs={ROWS} issues={[]} />);

    // The Done report is where this matters most: it is the record a reader
    // trusts, and dec-9 freezes it. "2 ACs · 2 verified" for a Spec that was
    // waved through the gate is the sentence dec-7 exists to prevent.
    expect(screen.getByTestId('done-superseded-count')).toHaveTextContent('1 gate override');
  });

  it('DecisionAcStrip names it in the caption', () => {
    tagAc(acRef(22));
    render(
      <DecisionAcStrip acs={ROWS_UNDER_DEC} decisionId="dec-1" gateOverrides={3} />,
    );
    expect(screen.getByTestId('decision-ac-strip-caption')).toHaveTextContent(
      '3 gate overrides',
    );
  });

  it('singularises one override and stays silent at zero', () => {
    tagAc(acRef(22));
    render(<SpecHealthChip health={{ ...HEALTH_WITH_OVERRIDES, overrides: 1 }} />);
    expect(screen.getByTestId('spec-health-chip')).toHaveTextContent('1 gate override');
    expect(screen.getByTestId('spec-health-chip')).not.toHaveTextContent('1 gate overrides');
  });

  it('renders BOTH counts when a Spec has retired a criterion and overridden its gate', () => {
    tagAc(acRef(22));
    // The compounding case. dec-2's count and dec-7's count are separate acts
    // and must both be legible — a surface that showed one and swallowed the
    // other would pass every single-count assertion above.
    render(
      <SpecHealthChip health={{ ...HEALTH_WITH_OVERRIDES, superseded: 1, overrides: 2 }} />,
    );
    const chip = screen.getByTestId('spec-health-chip');
    expect(chip).toHaveTextContent('1 superseded');
    expect(chip).toHaveTextContent('2 gate overrides');
  });
});
