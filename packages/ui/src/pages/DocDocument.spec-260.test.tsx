// spec-260 t-6 — the QA Report render seats on the Spec page.
//
// Renders the REAL DocDocument (heavy panels stubbed to markers, the REAL
// QaReportCard) with a doc whose sections include qa_report rows, and asserts:
//
//   ac-11 : the report renders READ-ONLY — no inline-edit affordance.
//   ac-12 : three seats — a collapsible card above the ACs/Issues columns in
//           Verify; a "QA Report" sub-tab in Build (default stays Tasks/Issues,
//           quiet empty state before the first hand-off); and NOT in the
//           Specify "Narrative" sub-tab. (The Done seat is covered in
//           DoneSummary.spec-260.test.tsx — DoneSummary is stubbed here.)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import type { DocWithGraph } from '../api/types';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-260/acs/ac-${n}`;

// ── Heavy children → identity markers (the spec-159 harness shape) ──────────
vi.mock('../components/DecisionPanel', () => ({
  DecisionPanel: () => <div data-testid="decision-panel" />,
}));
vi.mock('../components/AcPanel', () => ({
  AcPanel: () => <div data-testid="ac-panel" />,
}));
vi.mock('../components/TaskPanel', () => ({
  TaskPanel: () => <div data-testid="task-panel" />,
}));
vi.mock('../components/IssuePanel', () => ({
  IssuePanel: () => <div data-testid="issue-panel" />,
}));
vi.mock('../components/AllComments', () => ({
  AllComments: () => <div data-testid="all-comments" />,
}));
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
vi.mock('../components/DoneSummary', () => ({
  DoneSummary: () => <div data-testid="done-summary" />,
}));

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

let docStatus: DocWithGraph['status'] = 'verify';
// Whether the doc carries QA report sections (the empty-state tests flip this).
let withReports = true;

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
        content: 'Session ONE report body.',
        createdAt: '2026-06-02T00:00:00Z',
      }),
      section({
        sectionType: 'qa_report-2',
        seq: 3,
        title: 'QA Report',
        content: 'Session TWO report body.',
        createdAt: '2026-06-03T00:00:00Z',
      }),
    );
  }
  return {
    id: 'doc-uuid',
    handle: 'spec-260',
    title: 'QA report seats',
    docType: 'spec',
    status: docStatus,
    creator: { name: 'Barrie', email: 'barrie@mindset.ai' },
    createdAt: '2026-06-01T00:00:00Z',
    statusChangedAt: '2026-06-04T00:00:00Z',
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
    <MemoryRouter initialEntries={['/n/m/specs/spec-260']}>
      <HeaderSlotProvider>
        <Routes>
          <Route path="/:ns/:mx/specs/:id" element={<DocDocument />} />
        </Routes>
      </HeaderSlotProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  withReports = true;
});

describe('spec-260 — QA Report render seats', () => {
  it('ac-12: Verify front-loads a collapsible QA Report card ABOVE the ACs│Issues columns', async () => {
    tagAc(AC(12));
    renderAt('verify');

    const card = await screen.findByTestId('qa-report-card');
    const acPanel = await screen.findByTestId('ac-panel');
    expect(screen.getByTestId('issue-panel')).toBeInTheDocument();

    // Front-loaded: the card precedes the two-column area in document order.
    expect(card.compareDocumentPosition(acPanel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Expanded by default (the cold verifier reads it first) — latest session shows.
    expect(screen.getByTestId('qa-report-content')).toHaveTextContent('Session TWO report body.');

    // Collapsible: it folds away once read.
    fireEvent.click(screen.getByTestId('qa-report-toggle'));
    expect(screen.queryByTestId('qa-report-content')).not.toBeInTheDocument();
  });

  it('ac-12 (dec-2 display): prior build sessions stay reachable through the version switcher', async () => {
    tagAc(AC(12));
    renderAt('verify');

    await screen.findByTestId('qa-report-card');
    const switcher = screen.getByTestId('qa-report-version-switcher');
    fireEvent.change(switcher, { target: { value: '1' } }); // index 1 = the older session
    expect(screen.getByTestId('qa-report-content')).toHaveTextContent('Session ONE report body.');
  });

  it('ac-12: Build carries a QA Report sub-tab; Tasks│Issues stays the default view', async () => {
    tagAc(AC(12));
    renderAt('build');

    // Default tab: the working two-column, no report content.
    await screen.findByTestId('task-panel');
    expect(screen.getByTestId('issue-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('qa-report-content')).not.toBeInTheDocument();

    // The secondary tab reveals the report.
    fireEvent.click(screen.getByText('QA Report'));
    expect(screen.getByTestId('qa-report-content')).toHaveTextContent('Session TWO report body.');
    expect(screen.queryByTestId('task-panel')).not.toBeInTheDocument();
  });

  it('ac-12: before the first hand-off the Build tab shows a quiet empty state', async () => {
    tagAc(AC(12));
    withReports = false;
    renderAt('build');

    await screen.findByTestId('task-panel');
    fireEvent.click(screen.getByText('QA Report'));
    expect(screen.getByTestId('qa-report-empty')).toHaveTextContent(
      'No QA report yet — generated when build hands off to verify',
    );
  });

  it('ac-12: Verify renders no card at all when no report exists (nothing to front-load)', async () => {
    withReports = false;
    renderAt('verify');
    await screen.findByTestId('ac-panel');
    expect(screen.queryByTestId('qa-report-card')).not.toBeInTheDocument();
  });

  it('ac-12: qa_report sections are EXCLUDED from the Specify Narrative sub-tab', async () => {
    tagAc(AC(12));
    renderAt('specify');

    await screen.findByText('Narrative');
    await waitFor(() => expect(screen.getAllByTestId('section-card')).toHaveLength(1));
    // Only the plan-prose section renders as a narrative card; neither qa_report
    // row leaks in as frozen plan prose.
    const types = screen
      .getAllByTestId('section-card')
      .map((el) => el.getAttribute('data-section-type'));
    expect(types).toEqual(['overview']);
  });

  it('ac-11: the report renders read-only — no inline-edit affordance inside the card', async () => {
    tagAc(AC(11));
    renderAt('verify');

    const card = await screen.findByTestId('qa-report-card');
    // No editing surface of any kind inside the card: the only interactive
    // elements are the collapse toggle and the version switcher.
    expect(card.querySelector('textarea')).toBeNull();
    expect(card.querySelector('input')).toBeNull();
    expect(card.querySelector('[contenteditable="true"]')).toBeNull();
    const buttons = Array.from(card.querySelectorAll('button')).map(
      (b) => b.getAttribute('data-testid') ?? '',
    );
    expect(buttons).toEqual(['qa-report-toggle']);
  });
});
