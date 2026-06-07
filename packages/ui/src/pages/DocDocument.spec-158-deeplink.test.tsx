// spec-158 t-4 — the issue deep-link must survive spec-159's phase-tab restructure.
//
// spec-159 only mounts IssuePanel under the Build / Verify layouts; the Specify view
// (draft / specify) and the done report don't render it. A `specs/spec-N/issues/issue-N`
// (or `?issue=issue-N`) deep-link therefore has to land the page on a phase view
// that actually renders IssuePanel, so `highlightIssueHandle` reaches it and the
// matching card scrolls + pulses — including on a fresh full-page navigation.
//
//   ac-4  : the issue deep-link lands directly on the issue via the shared
//           blue-highlight affordance (one mechanism, not a parallel one).
//   ac-11 : the canonical issue URL opens the parent Spec landed on the issue.
//   ac-17 : that URL renders the Spec page with the issues view open, on a fresh
//           full-page navigation, whatever phase the Spec is in.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import type { DocWithGraph } from '../api/types';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-158/acs/ac-${n}`;

// ── Heavy children → identity markers. IssuePanel records the highlight handle
//    it receives so we can assert the deep-link reached it. ────────────────────
let issuePanelHandle: string | null | undefined = 'UNSET';
vi.mock('../components/DecisionPanel', () => ({
  DecisionPanel: () => <div data-testid="decision-panel" />,
}));
vi.mock('../components/AcPanel', () => ({ AcPanel: () => <div data-testid="ac-panel" /> }));
vi.mock('../components/TaskPanel', () => ({ TaskPanel: () => <div data-testid="task-panel" /> }));
vi.mock('../components/IssuePanel', () => ({
  IssuePanel: (props: { highlightIssueHandle?: string | null }) => {
    issuePanelHandle = props.highlightIssueHandle;
    return <div data-testid="issue-panel" data-handle={props.highlightIssueHandle ?? ''} />;
  },
}));
vi.mock('../components/AllComments', () => ({ AllComments: () => <div data-testid="all-comments" /> }));
vi.mock('../components/SectionCard', () => ({ SectionCard: () => <div data-testid="section-card" /> }));
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
function makeDoc(): DocWithGraph {
  return {
    id: 'doc-uuid',
    handle: 'spec-158',
    title: 'Issues surface',
    docType: 'spec',
    status: docStatus,
    creator: { name: 'Barrie', email: 'barrie@mindset.ai' },
    createdAt: '2026-06-01T00:00:00Z',
    statusChangedAt: '2026-06-04T00:00:00Z',
    narrativeLastConsolidatedAt: null,
    sections: [{ id: 's-1', seq: 1, title: 'Intro', body: 'x' }],
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
import { HeaderSlotProvider, useHeaderSlotContent } from '../components/HeaderSlot';

function HeaderSink() {
  return <div data-testid="header-slot">{useHeaderSlotContent()}</div>;
}

function renderAt(status: DocWithGraph['status'], path: string) {
  docStatus = status;
  return render(
    <MemoryRouter initialEntries={[path]}>
      <HeaderSlotProvider>
        <HeaderSink />
        <Routes>
          <Route path="/:ns/:mx/specs/:id" element={<DocDocument />} />
          <Route path="/:ns/:mx/specs/:id/issues/:issueId" element={<DocDocument />} />
        </Routes>
      </HeaderSlotProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  issuePanelHandle = 'UNSET';
});

describe('spec-158 — issue deep-link survives the spec-159 phase-tab layout', () => {
  it('a `?issue=issue-N` link on a specify-phase Spec mounts IssuePanel with the handle (ac-4, ac-11, ac-17)', async () => {
    tagAc(AC(4));
    tagAc(AC(11));
    tagAc(AC(17));
    // A Spec in SPECIFY: the current phase tab is Specify, which has no IssuePanel.
    // The deep-link must redirect the view to a tab that mounts it.
    renderAt('specify', '/n/m/specs/spec-158?issue=issue-4');

    await waitFor(() => expect(screen.getByTestId('issue-panel')).toBeInTheDocument());
    expect(screen.getByTestId('issue-panel')).toHaveAttribute('data-handle', 'issue-4');
    expect(issuePanelHandle).toBe('issue-4');
  });

  it('the canonical `/specs/spec-N/issues/issue-N` path on a specify-phase Spec mounts IssuePanel (ac-11, ac-17)', async () => {
    tagAc(AC(11));
    tagAc(AC(17));
    // Fresh full-page navigation of the canonical URL — the :issueId route param
    // path, not the query param.
    renderAt('specify', '/n/m/specs/spec-158/issues/issue-7');

    await waitFor(() => expect(screen.getByTestId('issue-panel')).toBeInTheDocument());
    expect(screen.getByTestId('issue-panel')).toHaveAttribute('data-handle', 'issue-7');
  });

  it('a build-phase Spec already shows IssuePanel and passes the handle straight through (ac-4, ac-17)', async () => {
    tagAc(AC(4));
    tagAc(AC(17));
    // Build already renders Tasks | Issues, so no redirect is needed — the handle
    // still has to reach IssuePanel.
    renderAt('build', '/n/m/specs/spec-158/issues/issue-2');

    await waitFor(() => expect(screen.getByTestId('issue-panel')).toBeInTheDocument());
    expect(screen.getByTestId('issue-panel')).toHaveAttribute('data-handle', 'issue-2');
  });

  it('with no issue deep-link a specify-phase Spec stays on Specify and does not mount IssuePanel', async () => {
    renderAt('specify', '/n/m/specs/spec-158');

    await screen.findByTestId('section-card');
    expect(screen.queryByTestId('issue-panel')).not.toBeInTheDocument();
  });
});
