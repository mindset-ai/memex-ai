// spec-566 t-5 — every surface that renders AC coverage renders the superseded
// count beside it.
//
//   ac-11  asserted PER SURFACE, by mounting each one [std-45]. A service-level
//          test that the count is RETURNED is green while the UI still renders
//          the old shape, which is exactly the failure this Spec is about.
//   ac-13  the live percentage excludes superseded criteria from numerator and
//          denominator. The shared worked example — 10 verified of 11 with one
//          superseded — is used on every surface that shows a ratio, so "never
//          91%" is checked in nine places rather than argued once.
//
// NINE SURFACES, NOT SEVEN. ac-11 names seven. Reading the code for the scan
// turned up two more that render the same shape and were counting superseded
// rows in their totals:
//
//   • DoneSummary.tsx      — "{N} ACs · {M} verified" on the Done report. The
//                            worst place for an unfalsifiable badge: it is the
//                            record a reader trusts, and dec-9 freezes it.
//   • DecisionAcStrip.tsx  — "{N} ACs · {M} verified" under each resolved
//                            Decision.
//
// They are covered here rather than exempted. Excluding them would put the lie
// in the allowlist. ac-11's text is left alone — a superset satisfies it.
//
// HotSpecs renders no number itself; AcCells does, and HotSpecs embeds it. Both
// are asserted: AcCells directly, HotSpecs by mounting the card and seeing the
// count transitively.
//
// PALETTE. std-27 is scoped to charts and data-viz (cl-22/cl-24) and its hues
// are a reserved vocabulary (cl-3). A plain textual count is neither, so it
// renders in neutral app tokens — claiming a reserved hue would assert a
// meaning that belongs to something else.

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
import type { ActivityRow, PresentRow } from './pulse/types';

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

vi.mock('./ChatContext', () => ({
  useChat: () => ({ addContextChip: vi.fn() }),
}));

beforeEach(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  vi.mocked(fetchAcAlignmentHistory).mockResolvedValue([]);
});

// ──────────────────────────────────────────────────────────────────────────
// The worked example, built once.
//
// ac-13's number needs BOTH readings of 100% to hold: `covered` keys off
// "has at least one test" while `verified` is a verification state. The ten
// live criteria therefore each carry a passing test, so a surface reading
// either way reports 100% — otherwise this fixture would pass for the wrong
// reason on half the surfaces.
// ──────────────────────────────────────────────────────────────────────────

function makeAc(
  seq: number,
  status: 'active' | 'superseded',
  opts: { decisionId?: string } = {},
): AcWithVerification {
  return {
    ac: {
      id: `ac-uuid-${seq}`,
      memexId: 'mx',
      briefId: 'doc-uuid',
      seq,
      kind: 'implementation',
      statement: `Criterion ${seq}`,
      status,
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
    parents: opts.decisionId ? [{ kind: 'decision', id: opts.decisionId, seq: 1, title: 'D' }] : [],
  } as unknown as AcWithVerification;
}

/** 10 live + verified, 1 superseded. 11 rows on the wire; 10 live. */
function tenOfElevenRows(opts: { decisionId?: string } = {}): AcWithVerification[] {
  return [
    ...Array.from({ length: 10 }, (_, i) => makeAc(i + 1, 'active', opts)),
    makeAc(11, 'superseded', opts),
  ];
}

/** The same example in `AcHealth` shape — `totalActive` is already live-only. */
const HEALTH_10_OF_11: AcHealth = {
  totalActive: 10,
  covered: 10,
  verified: 10,
  failing: 0,
  stale: 0,
  untested: 0,
  accepted: 0,
  superseded: 1,
  overrides: 0,
};

/** The same example with nothing superseded — the silence control. */
const HEALTH_CLEAN: AcHealth = { ...HEALTH_10_OF_11, superseded: 0 };

// ──────────────────────────────────────────────────────────────────────────
// Surface 1 — AcPanel (the AC tab's unified header).
// ──────────────────────────────────────────────────────────────────────────

describe('ac-11/ac-13 — AcPanel', () => {
  it('renders 100% over the live 10 and names the 1 superseded', async () => {
    tagAc(acRef(11));
    tagAc(acRef(13));
    vi.mocked(fetchAcsForBrief).mockResolvedValue(tenOfElevenRows());

    render(<AcPanel docId="doc-uuid" />);

    const header = await screen.findByTestId('ac-unified-header');
    expect(within(header).getByTestId('ac-superseded-count')).toHaveTextContent(
      '1 superseded',
    );
    // The maths is over the live set: 10 of 10 have tests, so 100%, and the
    // caption names 10 — not the 11 rows the server sent.
    expect(header).toHaveTextContent('All 10 ACs have tests');
    expect(header).not.toHaveTextContent('of 11');
    expect(header).not.toHaveTextContent('91%');
  });

  it('says nothing when nothing is superseded', async () => {
    tagAc(acRef(11));
    vi.mocked(fetchAcsForBrief).mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => makeAc(i + 1, 'active')),
    );

    render(<AcPanel docId="doc-uuid" />);

    const header = await screen.findByTestId('ac-unified-header');
    expect(within(header).queryByTestId('ac-superseded-count')).toBeNull();
    expect(header).not.toHaveTextContent('superseded');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Surface 2 — AcAboutDialog. (This component had NO test file before t-5.)
// ──────────────────────────────────────────────────────────────────────────

describe('ac-11/ac-13 — AcAboutDialog', () => {
  it('counts the live ACs in its prose and names the retired one', () => {
    tagAc(acRef(11));
    tagAc(acRef(13));

    render(<AcAboutDialog rows={tenOfElevenRows()} onClose={() => {}} />);

    expect(screen.getByTestId('ac-about-superseded-count')).toHaveTextContent(
      '1 superseded',
    );
    // "Of the 10 ACs, 10 are currently verified" — never "of the 11".
    expect(screen.getByText(/Of the 10 ACs/)).toBeInTheDocument();
    expect(screen.queryByText(/Of the 11 ACs/)).toBeNull();
  });

  it('says nothing when nothing is superseded', () => {
    tagAc(acRef(11));

    render(
      <AcAboutDialog
        rows={Array.from({ length: 10 }, (_, i) => makeAc(i + 1, 'active'))}
        onClose={() => {}}
      />,
    );

    expect(screen.queryByTestId('ac-about-superseded-count')).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Surface 3 — SpecHealthIndicator's chip.
// ──────────────────────────────────────────────────────────────────────────

describe('ac-11 — SpecHealthChip', () => {
  it('renders the count beside the ratio', () => {
    tagAc(acRef(11));

    render(<SpecHealthChip health={HEALTH_10_OF_11} />);

    const chip = screen.getByTestId('spec-health-chip');
    expect(chip).toHaveTextContent('10/10 verified');
    expect(within(chip).getByTestId('spec-health-superseded')).toHaveTextContent(
      '1 superseded',
    );
  });

  it('still renders when every criterion was retired, instead of vanishing', () => {
    tagAc(acRef(11));

    // Vacuity guard: with superseded 0 this same health renders NOTHING, so the
    // assertion below is about the count and not about some unrelated branch.
    const allRetired: AcHealth = { ...HEALTH_CLEAN, totalActive: 0, covered: 0, verified: 0 };
    const { container } = render(<SpecHealthChip health={allRetired} />);
    expect(container).toBeEmptyDOMElement();

    render(<SpecHealthChip health={{ ...allRetired, superseded: 3 }} />);
    expect(screen.getByTestId('spec-health-chip')).toHaveTextContent('3 superseded');
  });

  it('says nothing when nothing is superseded', () => {
    tagAc(acRef(11));
    render(<SpecHealthChip health={HEALTH_CLEAN} />);
    expect(screen.getByTestId('spec-health-chip')).not.toHaveTextContent('superseded');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Surface 4 — AcCells, the bar that carries HotSpecs' number.
// ──────────────────────────────────────────────────────────────────────────

describe('ac-11 — AcCells', () => {
  it('renders the count beside 10/10 and in the bar’s accessible name', () => {
    tagAc(acRef(11));

    render(<AcCells health={HEALTH_10_OF_11} />);

    const cells = screen.getByTestId('ac-cells');
    expect(cells).toHaveTextContent('10/10');
    expect(within(cells).getByTestId('ac-cells-superseded')).toHaveTextContent(
      '1 superseded',
    );
    // The bar is role="img" — a screen reader gets the count too, not just
    // sighted users.
    expect(screen.getByRole('img')).toHaveAccessibleName(/1 superseded/);
  });

  it('says nothing when nothing is superseded', () => {
    tagAc(acRef(11));
    render(<AcCells health={HEALTH_CLEAN} />);
    expect(screen.getByTestId('ac-cells')).not.toHaveTextContent('superseded');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Surface 5 — HotSpecs (transitively, via the AcCells it embeds).
// ──────────────────────────────────────────────────────────────────────────

describe('ac-11 — HotSpecs', () => {
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
  const present: PresentRow[] = [];

  function renderHot(health: AcHealth) {
    return render(
      <MemoryRouter>
        <HotSpecs
          present={present}
          activity={[activity]}
          now={NOW}
          specHandle={() => 'spec-566'}
          specTitle={() => 'Title'}
          specPhase={() => 'build'}
          specNarrative={() => 'narrative'}
          specAcHealth={() => health}
          specHref={(h) => `/mindset-prod/memex-building-itself/specs/${h}`}
        />
      </MemoryRouter>,
    );
  }

  it('carries the count onto the Hot Spec card', () => {
    tagAc(acRef(11));
    renderHot(HEALTH_10_OF_11);

    const card = screen.getAllByTestId('hot-spec-card')[0];
    expect(within(card).getByTestId('ac-cells')).toHaveTextContent('10/10');
    expect(within(card).getByTestId('ac-cells-superseded')).toHaveTextContent(
      '1 superseded',
    );
  });

  it('says nothing when nothing is superseded', () => {
    tagAc(acRef(11));
    renderHot(HEALTH_CLEAN);
    const card = screen.getAllByTestId('hot-spec-card')[0];
    expect(within(card).getByTestId('ac-cells')).not.toHaveTextContent('superseded');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Surface 6 — SpecRefCard.
// ──────────────────────────────────────────────────────────────────────────

describe('ac-11/ac-13 — SpecRefCard', () => {
  function makeDoc(acHealth: AcHealth | undefined): DocSummary {
    return {
      id: 'id-1',
      handle: 'spec-566',
      title: 'A criterion cannot be rewritten in silence',
      docType: 'spec',
      status: 'build',
      parentDocId: null,
      createdAt: '2026-09-01T10:00:00Z',
      statusChangedAt: '2026-09-10T10:00:00Z',
      sectionCount: 4,
      archivedAt: null,
      taskProgress: { total: 8, complete: 4, inProgress: 1, notStarted: 3 },
      acHealth,
    } as unknown as DocSummary;
  }

  it('reports 100% of 10 with the count beside it — never 91%', () => {
    tagAc(acRef(11));
    tagAc(acRef(13));

    render(<SpecRefCard id="id-1" doc={makeDoc(HEALTH_10_OF_11)} />);

    const line = screen.getByTestId('spec-ref-acs');
    expect(line).toHaveTextContent('100% of 10 acceptance criteria verified');
    expect(line).toHaveTextContent('1 superseded');
    expect(line).not.toHaveTextContent('91%');
    expect(line).not.toHaveTextContent('of 11');
  });

  it('does not claim "no acceptance criteria yet" when they were all retired', () => {
    tagAc(acRef(11));

    const allRetired: AcHealth = {
      ...HEALTH_CLEAN,
      totalActive: 0,
      covered: 0,
      verified: 0,
      superseded: 4,
    };
    render(<SpecRefCard id="id-1" doc={makeDoc(allRetired)} />);

    const line = screen.getByTestId('spec-ref-acs');
    expect(line).toHaveTextContent('4 superseded');
    expect(line).not.toHaveTextContent('No acceptance criteria yet');
  });

  it('says nothing when nothing is superseded', () => {
    tagAc(acRef(11));
    render(<SpecRefCard id="id-1" doc={makeDoc(HEALTH_CLEAN)} />);
    expect(screen.getByTestId('spec-ref-acs')).not.toHaveTextContent('superseded');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Surface 7 — SpecSummaryStrip (the Stats tab header).
// ──────────────────────────────────────────────────────────────────────────

describe('ac-11/ac-13 — SpecSummaryStrip', () => {
  function summary(superseded: number): SpecLifecycleSummary {
    return {
      createdAt: '2026-09-01T10:00:00Z',
      currentPhase: 'build',
      ageDays: 15,
      timeInCurrentPhaseDays: 5,
      // NOT 11 — the `/11` assertion below must be about the AC denominator,
      // and a task total of 11 would satisfy it from the Tasks stat instead.
      tasks: { total: 8, complete: 4 },
      // `total` is the LIVE set — the server filters to status = 'active'.
      acs: { total: 10, verified: 10, failing: 0, covered: 10, superseded },
    };
  }

  it('shows 100% over 10 with the count in the sub-line', () => {
    tagAc(acRef(11));
    tagAc(acRef(13));

    render(<SpecSummaryStrip summary={summary(1)} />);

    const strip = screen.getByTestId('spec-summary-strip');
    expect(strip).toHaveTextContent('10/10 verified · 1 superseded');
    expect(strip).not.toHaveTextContent('/11');
    expect(strip).not.toHaveTextContent('91%');
  });

  it('says nothing when nothing is superseded', () => {
    tagAc(acRef(11));
    render(<SpecSummaryStrip summary={summary(0)} />);
    expect(screen.getByTestId('spec-summary-strip')).not.toHaveTextContent('superseded');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Surface 8 — DoneSummary. NOT in ac-11's list of seven; found by the scan.
// ──────────────────────────────────────────────────────────────────────────

describe('ac-11/ac-13 — DoneSummary (the eighth surface)', () => {
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
  } as unknown as DocWithGraph;

  function renderDone(rows: AcWithVerification[]) {
    return render(
      <DoneSummary doc={doc} decisions={[]} tasks={[]} acs={rows} issues={[]} />,
    );
  }

  it('reports 10 ACs · 10 verified · 1 superseded — never 11 ACs · 10 verified', () => {
    tagAc(acRef(11));
    tagAc(acRef(13));

    renderDone(tenOfElevenRows());

    expect(screen.getByTestId('done-superseded-count')).toHaveTextContent('1 superseded');
    expect(screen.getByText(/10 ACs/)).toBeInTheDocument();
    // The sentence the Done report must never produce for this Spec.
    expect(screen.queryByText(/11 ACs/)).toBeNull();
  });

  it('says nothing when nothing is superseded', () => {
    tagAc(acRef(11));
    renderDone(Array.from({ length: 10 }, (_, i) => makeAc(i + 1, 'active')));
    expect(screen.queryByTestId('done-superseded-count')).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Surface 9 — DecisionAcStrip. Also found by the scan, not by ac-11's list.
// ──────────────────────────────────────────────────────────────────────────

describe('ac-11/ac-13 — DecisionAcStrip (the ninth surface)', () => {
  it('counts the live criteria this Decision spawned and names the retired one', () => {
    tagAc(acRef(11));
    tagAc(acRef(13));

    render(
      <DecisionAcStrip acs={tenOfElevenRows({ decisionId: 'dec-1' })} decisionId="dec-1" />,
    );

    const caption = screen.getByTestId('decision-ac-strip-caption');
    expect(caption).toHaveTextContent('10 ACs · 10 verified · 1 superseded');
    expect(caption).not.toHaveTextContent('11 ACs');
  });

  it('says nothing when nothing is superseded', () => {
    tagAc(acRef(11));
    render(
      <DecisionAcStrip
        acs={Array.from({ length: 10 }, (_, i) => makeAc(i + 1, 'active', { decisionId: 'dec-1' }))}
        decisionId="dec-1"
      />,
    );
    expect(screen.getByTestId('decision-ac-strip-caption')).not.toHaveTextContent(
      'superseded',
    );
  });
});
