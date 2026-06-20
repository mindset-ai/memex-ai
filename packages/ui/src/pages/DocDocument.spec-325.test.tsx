// spec-325 — a comment deep-link (`?comment=c-N`) must open the comment IN SITU
// in the narrative (its section's spec-319 gutter), never on the flat AllComments
// tab. DocDocument's job: do NOT select the comments sub-tab; show the narrative
// and thread the target seq down to the section cards so the owning one pins it.
//
//   ac-5 : the deep-link lands in-context (narrative), never the flat Comments tab,
//          and the target seq reaches the section cards.
//   ac-9 : the flat Comments tab is not the deep-link's destination.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import type { DocWithGraph } from '../api/types';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-325/acs/ac-${n}`;

// SectionCard records the deepLinkCommentSeq it receives so we can assert the
// deep-link reached the narrative surface (not the flat tab).
let sectionDeepLinkSeq: number | null | undefined = 'UNSET' as never;
vi.mock('../components/SectionCard', () => ({
  SectionCard: (props: { deepLinkCommentSeq?: number | null }) => {
    sectionDeepLinkSeq = props.deepLinkCommentSeq;
    return <div data-testid="section-card" data-deeplink={props.deepLinkCommentSeq ?? ''} />;
  },
}));
// If AllComments renders, the deep-link wrongly landed on the flat tab.
vi.mock('../components/AllComments', () => ({
  AllComments: () => <div data-testid="all-comments" />,
}));
vi.mock('../components/DecisionPanel', () => ({ DecisionPanel: () => <div data-testid="decision-panel" /> }));
vi.mock('../components/AcPanel', () => ({ AcPanel: () => <div data-testid="ac-panel" /> }));
vi.mock('../components/TaskPanel', () => ({ TaskPanel: () => <div data-testid="task-panel" /> }));
vi.mock('../components/IssuePanel', () => ({ IssuePanel: () => <div data-testid="issue-panel" /> }));
vi.mock('../components/DocOutline', () => ({ DocOutline: () => <div data-testid="doc-outline" /> }));
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
    handle: 'spec-325',
    title: 'Comments in situ',
    docType: 'spec',
    // 'specify' defaults to the narrative sub-tab, so the no-deep-link case still
    // renders the section cards. The deep-link behaviour under test is phase-
    // independent — a `?comment` param forces 'narrative' in any phase.
    status: 'specify',
    creator: { name: 'Wic', email: 'wic@mindset.ai' },
    createdAt: '2026-06-01T00:00:00Z',
    statusChangedAt: '2026-06-04T00:00:00Z',
    narrativeLastConsolidatedAt: null,
    sections: [{ id: 's-1', seq: 1, title: 'Overview', body: 'x' }],
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

describe('spec-325 — comment deep-link lands in situ, never the flat Comments tab', () => {
  it('a `?comment=c-3` link shows the narrative section cards and threads the seq down (ac-1, ac-5)', async () => {
    tagAc(AC(1)); // scope: clicking a comment link opens it in situ (in the section view)
    tagAc(AC(5));
    renderAt('/n/m/specs/spec-325?comment=c-3');

    // The narrative (section cards) is shown...
    await waitFor(() => expect(screen.getByTestId('section-card')).toBeInTheDocument());
    // ...and the target seq reached the section card.
    expect(screen.getByTestId('section-card')).toHaveAttribute('data-deeplink', '3');
    expect(sectionDeepLinkSeq).toBe(3);
  });

  it('a `?comment=c-3` link does NOT land on the flat AllComments tab (ac-1, ac-5, ac-9)', async () => {
    tagAc(AC(1)); // scope: never lands on the flat Comments tab
    tagAc(AC(5));
    tagAc(AC(9));
    renderAt('/n/m/specs/spec-325?comment=c-3');

    await waitFor(() => expect(screen.getByTestId('section-card')).toBeInTheDocument());
    expect(screen.queryByTestId('all-comments')).not.toBeInTheDocument();
  });

  it('with no comment param the section cards do not receive a deep-link seq', async () => {
    renderAt('/n/m/specs/spec-325');
    await waitFor(() => expect(screen.getByTestId('section-card')).toBeInTheDocument());
    expect(screen.getByTestId('section-card')).toHaveAttribute('data-deeplink', '');
  });
});
