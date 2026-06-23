// spec-361 — page-level wiring: comments fetched for a Spec render as child rows
// in the real DocOutline, and clicking one navigates IN SITU (spec-325 path) —
// threading the seq to the owning SectionCard and never the flat AllComments tab.
//
//   ac-3 : clicking a comment child sets the in-situ deep-link (seq reaches the
//          section card) and does NOT land on the flat Comments tab.
//   ac-4 : a comment present on load shows as a child under its segment, no
//          manual refresh.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import type { DocWithGraph } from '../api/types';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-361/acs/ac-${n}`;

// SectionCard records the deepLinkCommentSeq it receives so we can assert the
// click reached the in-situ narrative surface (not the flat tab).
let sectionDeepLinkSeq: number | null | undefined = 'UNSET' as never;
vi.mock('../components/SectionCard', () => ({
  SectionCard: (props: { deepLinkCommentSeq?: number | null }) => {
    sectionDeepLinkSeq = props.deepLinkCommentSeq;
    return <div data-testid="section-card" data-deeplink={props.deepLinkCommentSeq ?? ''} />;
  },
}));
// If AllComments renders, the click wrongly landed on the flat tab.
vi.mock('../components/AllComments', () => ({
  AllComments: () => <div data-testid="all-comments" />,
}));
vi.mock('../components/DecisionPanel', () => ({ DecisionPanel: () => <div data-testid="decision-panel" /> }));
vi.mock('../components/AcPanel', () => ({ AcPanel: () => <div data-testid="ac-panel" /> }));
vi.mock('../components/TaskPanel', () => ({ TaskPanel: () => <div data-testid="task-panel" /> }));
vi.mock('../components/IssuePanel', () => ({ IssuePanel: () => <div data-testid="issue-panel" /> }));
// NOTE: DocOutline is intentionally NOT mocked — it's the surface under test.
vi.mock('../components/TagPicker', () => ({ TagPicker: () => null }));
vi.mock('../components/BylineAssignees', () => ({ BylineAssignees: () => <div data-testid="byline-assignees" /> }));
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

function makeDoc(): DocWithGraph {
  return {
    id: 'doc-uuid',
    handle: 'spec-361',
    title: 'Comments in the outline',
    docType: 'spec',
    status: 'specify',
    creator: { name: 'Barrie', email: 'barrie@mindset.ai' },
    createdAt: '2026-06-01T00:00:00Z',
    statusChangedAt: '2026-06-04T00:00:00Z',
    narrativeLastConsolidatedAt: null,
    sections: [{ id: 's-1', seq: 1, title: 'Overview', body: 'x' }],
    decisions: [],
    tasks: [],
    tags: [],
  } as unknown as DocWithGraph;
}

const commentOnS1 = {
  id: 'cid-3',
  seq: 3,
  sectionId: 's-1',
  decisionId: null,
  taskId: null,
  authorName: 'Barrie',
  content: 'tighten the overview',
  resolution: null,
  resolvedAt: null,
  createdAt: '2026-06-10T00:00:00Z',
  source: 'human',
};

vi.mock('../api/client', () => ({
  NotFoundError: class NotFoundError extends Error {},
  fetchDoc: () => Promise.resolve(makeDoc()),
  fetchDocComments: () =>
    Promise.resolve({
      sections: [{ section: { id: 's-1', seq: 1, title: 'Overview' }, comments: [commentOnS1] }],
      decisions: [],
      tasks: [],
    }),
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

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <HeaderSlotProvider>
        <HeaderSink />
        <Routes>
          <Route path="/:ns/:mx/specs/:id" element={<DocDocument />} />
        </Routes>
      </HeaderSlotProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  sectionDeepLinkSeq = 'UNSET' as never;
});

describe('spec-361 — outline comment children drive in-situ navigation', () => {
  it('a comment present on load renders as a child row under its segment (ac-4)', async () => {
    tagAc(AC(4));
    renderAt('/n/m/specs/spec-361');
    // The fetched comment shows as a clickable child in the outline.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /tighten the overview/ })).toBeInTheDocument(),
    );
  });

  it('clicking a comment child threads the seq to the section card, never the flat tab (ac-3)', async () => {
    tagAc(AC(3));
    renderAt('/n/m/specs/spec-361');

    const child = await screen.findByRole('button', { name: /tighten the overview/ });
    // No deep-link before the click.
    expect(screen.getByTestId('section-card')).toHaveAttribute('data-deeplink', '');

    fireEvent.click(child);

    // After the click the owning SectionCard receives the seq (in situ)...
    await waitFor(() => expect(sectionDeepLinkSeq).toBe(3));
    expect(screen.getByTestId('section-card')).toHaveAttribute('data-deeplink', '3');
    // ...and the flat AllComments tab is never the destination.
    expect(screen.queryByTestId('all-comments')).not.toBeInTheDocument();
  });
});
