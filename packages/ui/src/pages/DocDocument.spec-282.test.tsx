// spec-282 t-1 — ONE persistent, all-tabs-present sub-tab control across phases.
//
// Renders the REAL DocDocument (heavy panels stubbed to markers, the REAL
// QaReportCard so the QA Report empty-state is exercised) and asserts the
// unified sub-tab control:
//
//   ac-8 / ac-9 : one <Tabs> carrying the exact ordered inventory —
//                 Narrative · Comments · Decisions & ACs · Agent Tasks & Issues ·
//                 QA Report — in every phase.
//   ac-1 / ac-2 : the same control persists across Specify/Build/Verify and the
//                 set never shrinks (Narrative & Comments reachable in Build and
//                 Verify).
//   ac-3        : the QA Report tab shows an honest empty-state placeholder
//                 before a report exists.
//   ac-4 / ac-10: each phase lands on its default sub-tab (Specify→Narrative,
//                 Build→Decisions & ACs, Verify→QA Report w/ Decisions & ACs
//                 fallback); an explicit selection is respected until the next
//                 phase navigation resets it to the new phase's default.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import type { DocWithGraph } from '../api/types';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-282/acs/ac-${n}`;

vi.mock('../components/DecisionPanel', () => ({
  DecisionPanel: () => <div data-testid="decision-panel" />,
}));
vi.mock('../components/AcPanel', () => ({ AcPanel: () => <div data-testid="ac-panel" /> }));
vi.mock('../components/TaskPanel', () => ({ TaskPanel: () => <div data-testid="task-panel" /> }));
vi.mock('../components/IssuePanel', () => ({ IssuePanel: () => <div data-testid="issue-panel" /> }));
vi.mock('../components/AllComments', () => ({ AllComments: () => <div data-testid="all-comments" /> }));
vi.mock('../components/SectionCard', () => ({
  SectionCard: (props: { section: { sectionType: string } }) => (
    <div data-testid="section-card" data-section-type={props.section.sectionType} />
  ),
}));
vi.mock('../components/DocOutline', () => ({ DocOutline: () => <div data-testid="doc-outline" /> }));
vi.mock('../components/TagPicker', () => ({ TagPicker: () => null }));
vi.mock('../components/BylineAssignees', () => ({
  BylineAssignees: () => <div data-testid="byline-assignees" />,
}));
vi.mock('../components/DoneSummary', () => ({ DoneSummary: () => <div data-testid="done-summary" /> }));

vi.mock('../hooks/useMemexAccess', () => ({
  useMemexAccess: () => ({ canWrite: true, isReadOnly: false }),
}));
vi.mock('../hooks/useDocRole', () => ({
  useDocRole: () => ({ myRole: 'editor', editors: [], loading: false, refetch: vi.fn() }),
}));
vi.mock('../hooks/useDocChangeStream', () => ({ useDocChangeStream: () => {} }));
vi.mock('../hooks/useOrgScaffoldBlocks', () => ({ useOrgScaffoldBlocks: () => [] }));
const chat = {
  setDocId: vi.fn(),
  setDoc: vi.fn(),
  setOpenCommentCount: vi.fn(),
  sendMessage: vi.fn(),
};
vi.mock('../components/ChatContext', () => ({ useChat: () => chat }));

let docStatus: DocWithGraph['status'] = 'specify';
let withReports = false;

function section(over: Record<string, unknown>) {
  return {
    id: `sec-${over.sectionType as string}`,
    docId: 'doc-uuid',
    title: null,
    description: null,
    content: 'body',
    status: 'active',
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-01T00:00:00Z',
    ...over,
  };
}

function makeDoc(): DocWithGraph {
  const sections = [
    section({ sectionType: 'overview', seq: 1, title: 'Overview', content: 'The plan prose.' }),
  ];
  if (withReports) {
    sections.push(
      section({
        sectionType: 'qa_report',
        seq: 2,
        title: 'QA Report',
        content: 'The latest session report.',
        createdAt: '2026-06-02T00:00:00Z',
      }),
    );
  }
  return {
    id: 'doc-uuid',
    handle: 'spec-282',
    title: 'Unified sub-tabs',
    docType: 'spec',
    status: docStatus,
    creator: { name: 'Barrie', email: 'barrie@mindset.ai' },
    createdAt: '2026-06-01T00:00:00Z',
    statusChangedAt: '2026-06-13T00:00:00Z',
    narrativeLastConsolidatedAt: null,
    sections,
    decisions: [],
    tasks: [],
    tags: [],
  } as unknown as DocWithGraph;
}

vi.mock('../api/client', () => ({
  NotFoundError: class NotFoundError extends Error {},
  fetchDoc: () => Promise.resolve(makeDoc()),
  fetchDocComments: () => Promise.resolve({ sections: [], decisions: [], tasks: [] }),
  fetchAcsForBrief: () => Promise.resolve([]),
  fetchIssues: () => Promise.resolve([]),
  fetchDocAssignees: () => Promise.resolve([]),
  archiveDoc: vi.fn(),
  pauseDoc: vi.fn(),
  unpauseDoc: vi.fn(),
  updateDocStatus: vi.fn(),
  promoteToEditor: vi.fn(),
  demoteToReviewer: vi.fn(),
}));

import { DocDocument } from './DocDocument';
import { HeaderSlotProvider } from '../components/HeaderSlot';

function renderAt(status: DocWithGraph['status']) {
  docStatus = status;
  return render(
    <MemoryRouter initialEntries={['/n/m/specs/spec-282']}>
      <HeaderSlotProvider>
        <Routes>
          <Route path="/:ns/:mx/specs/:id" element={<DocDocument />} />
        </Routes>
      </HeaderSlotProvider>
    </MemoryRouter>,
  );
}

const SUB_TABS = ['Narrative', 'Comments', 'Decisions & ACs', 'Agent Tasks & Issues', 'QA Report'];

// The sub-tab bar is the Tabs underline row; anchor on the Narrative button and
// read its sibling buttons in DOM order.
function subTabLabels(): string[] {
  const bar = screen.getByRole('button', { name: 'Narrative' }).parentElement!;
  return Array.from(bar.querySelectorAll('button')).map((b) => (b.textContent ?? '').trim());
}

function phaseTab(name: string) {
  return screen.getAllByRole('tab').find((t) => t.getAttribute('data-tab') === name)!;
}

beforeEach(() => {
  vi.clearAllMocks();
  withReports = false;
});

describe('spec-282 — unified sub-tab inventory & ordering (ac-8, ac-9)', () => {
  it('renders exactly Narrative · Comments · Decisions & ACs · Agent Tasks & Issues · QA Report, in order', async () => {
    tagAc(AC(8));
    tagAc(AC(9));
    renderAt('specify');
    await screen.findByText('Narrative');
    expect(subTabLabels()).toEqual(SUB_TABS);
  });

  it('the SAME inventory is present in Specify, Build AND Verify — one control, never swapped (ac-1, ac-2)', async () => {
    tagAc(AC(1));
    tagAc(AC(2));
    for (const phase of ['specify', 'build', 'verify'] as const) {
      const { unmount } = renderAt(phase);
      await screen.findByText('Narrative');
      expect(subTabLabels()).toEqual(SUB_TABS);
      // Narrative AND Comments stay reachable in Build and Verify (accretion
      // never removes an earlier tab).
      expect(screen.getByRole('button', { name: 'Narrative' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Comments' })).toBeInTheDocument();
      unmount();
    }
  });
});

describe('spec-282 — per-phase default landing (ac-4, ac-10)', () => {
  it('Specify lands on Narrative', async () => {
    tagAc(AC(4));
    tagAc(AC(10));
    renderAt('specify');
    expect(await screen.findByTestId('section-card')).toBeInTheDocument();
  });

  it('Build lands on Decisions & ACs', async () => {
    tagAc(AC(4));
    tagAc(AC(10));
    renderAt('build');
    expect(await screen.findByTestId('decision-panel')).toBeInTheDocument();
    expect(screen.getByTestId('ac-panel')).toBeInTheDocument();
  });

  it('Verify lands on QA Report when a report exists', async () => {
    tagAc(AC(4));
    tagAc(AC(10));
    withReports = true;
    renderAt('verify');
    expect(await screen.findByTestId('qa-report-card')).toBeInTheDocument();
    expect(screen.getByTestId('qa-report-content')).toBeInTheDocument();
  });

  it('Verify falls back to Decisions & ACs when no report exists', async () => {
    tagAc(AC(4));
    tagAc(AC(10));
    withReports = false;
    renderAt('verify');
    expect(await screen.findByTestId('ac-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('qa-report-card')).not.toBeInTheDocument();
  });

  it('an explicit selection is respected over the default, then phase navigation resets to the new default (ac-4, ac-10)', async () => {
    tagAc(AC(4));
    tagAc(AC(10));
    const user = userEvent.setup();
    renderAt('build');

    // Build's default is Decisions & ACs.
    await screen.findByTestId('decision-panel');

    // Pick Comments — the selection is respected (no default snap-back).
    await user.click(screen.getByRole('button', { name: 'Comments' }));
    expect(screen.getByTestId('all-comments')).toBeInTheDocument();
    expect(screen.queryByTestId('decision-panel')).not.toBeInTheDocument();

    // Browse the Verify phase pill — landing resets to Verify's default
    // (Decisions & ACs here, since no report), NOT the carried-over Comments.
    await user.click(phaseTab('verify'));
    expect(screen.getByTestId('ac-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('all-comments')).not.toBeInTheDocument();
  });
});

describe('spec-282 — honest empty state for absent artifacts (ac-3)', () => {
  it('the QA Report tab shows the explanatory placeholder before a report exists', async () => {
    tagAc(AC(3));
    const user = userEvent.setup();
    withReports = false;
    renderAt('build');
    await screen.findByTestId('decision-panel');

    await user.click(screen.getByRole('button', { name: 'QA Report' }));
    expect(screen.getByTestId('qa-report-empty')).toHaveTextContent(
      'No QA report yet — generated when build hands off to verify',
    );
  });

  it('the QA Report tab is reachable in Specify too, with the same placeholder (ac-2, ac-3)', async () => {
    tagAc(AC(2));
    tagAc(AC(3));
    const user = userEvent.setup();
    withReports = false;
    renderAt('specify');
    await screen.findByText('Narrative');

    await user.click(screen.getByRole('button', { name: 'QA Report' }));
    expect(screen.getByTestId('qa-report-empty')).toBeInTheDocument();
  });
});
