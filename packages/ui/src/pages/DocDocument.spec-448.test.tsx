// spec-448 t-8/t-9 — page-level wiring for document versioning:
//   ac-16: the header renders a version badge ONLY when the doc's current
//          version >= 2; a never-versioned (v1) spec shows no badge.
//   ac-33: the versioning UI (create-version menu item, switcher, badge) is
//          surfaced only for docType 'spec' in v1.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import type { DocWithGraph } from '../api/types';
import type { VersionSummary } from '../api/docs';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-448/acs/ac-${n}`;

vi.mock('../components/DecisionPanel', () => ({ DecisionPanel: () => <div data-testid="decision-panel" /> }));
vi.mock('../components/AcPanel', () => ({ AcPanel: () => <div data-testid="ac-panel" /> }));
vi.mock('../components/TaskPanel', () => ({ TaskPanel: () => <div data-testid="task-panel" /> }));
vi.mock('../components/IssuePanel', () => ({ IssuePanel: () => <div data-testid="issue-panel" /> }));
vi.mock('../components/AllComments', () => ({ AllComments: () => <div data-testid="all-comments" /> }));
vi.mock('../components/SectionCard', () => ({
  SectionCard: () => <div data-testid="section-card" />,
  MemoizedMarkdown: () => null,
}));
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

let mockDoc: DocWithGraph;
let mockVersions: VersionSummary[];

vi.mock('../api/client', () => ({
  NotFoundError: class NotFoundError extends Error {},
  fetchDoc: () => Promise.resolve(mockDoc),
  fetchDocComments: () => Promise.resolve({ sections: [], decisions: [], tasks: [] }),
  fetchAcsForBrief: () => Promise.resolve([]),
  fetchIssues: () => Promise.resolve([]),
  fetchDocAssignees: () => Promise.resolve([]),
  archiveDoc: vi.fn(),
  updateDocStatus: vi.fn(),
  promoteToEditor: vi.fn(),
  demoteToReviewer: vi.fn(),
}));

vi.mock('../api/docs', async () => {
  const actual = await vi.importActual<typeof import('../api/docs')>('../api/docs');
  return {
    ...actual,
    listVersions: () => Promise.resolve(mockVersions),
  };
});

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
          <Route path="/:ns/:mx/docs/:id" element={<DocDocument />} />
        </Routes>
      </HeaderSlotProvider>
    </MemoryRouter>,
  );
}

function makeDoc(overrides: Partial<DocWithGraph> = {}): DocWithGraph {
  return {
    id: 'doc-uuid',
    handle: 'spec-448',
    title: 'Document versioning',
    docType: 'spec',
    status: 'build',
    creator: { name: 'Barrie', email: 'barrie@mindset.ai' },
    createdAt: '2026-06-01T00:00:00Z',
    statusChangedAt: '2026-06-04T00:00:00Z',
    narrativeLastConsolidatedAt: null,
    sections: [],
    decisions: [],
    tasks: [],
    tags: [],
    ...overrides,
  } as unknown as DocWithGraph;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVersions = [];
});

describe('spec-448 — version badge (ac-16)', () => {
  it('renders NO badge for a never-versioned spec (version 1)', async () => {
    tagAc(AC(16));
    mockDoc = makeDoc({ version: 1 });
    renderAt('/n/m/specs/spec-448');

    await screen.findByText('Document versioning');
    expect(screen.queryByTestId('version-badge')).not.toBeInTheDocument();
  });

  it('renders a "V2" badge once the doc has been cut at least once (version >= 2)', async () => {
    tagAc(AC(16));
    mockDoc = makeDoc({ version: 2 });
    mockVersions = [
      { versionNumber: 1, name: 'First cut', createdAt: '2026-06-01T00:00:00.000Z', actorName: 'Barrie', restoredFromVersion: null },
    ];
    renderAt('/n/m/specs/spec-448');

    await screen.findByText('Document versioning');
    await waitFor(() => expect(screen.getByTestId('version-badge')).toBeInTheDocument());
    expect(screen.getByTestId('version-badge')).toHaveTextContent('V2 · First cut');
  });

  it('treats a doc with no version field as v1 (no badge) — legacy-fixture safety', async () => {
    tagAc(AC(16));
    mockDoc = makeDoc();
    renderAt('/n/m/specs/spec-448');

    await screen.findByText('Document versioning');
    expect(screen.queryByTestId('version-badge')).not.toBeInTheDocument();
  });
});

describe('spec-448 — versioning UI is spec-only (ac-33)', () => {
  it('shows "Create new version" in the ⋯ menu for docType "spec"', async () => {
    tagAc(AC(33));
    mockDoc = makeDoc({ docType: 'spec' });
    const user = userEvent.setup();
    renderAt('/n/m/specs/spec-448');

    await screen.findByText('Document versioning');
    const menuButton = await screen.findByRole('button', { name: /Actions for Document versioning/i });
    await user.click(menuButton);

    expect(await screen.findByRole('menuitem', { name: 'Create new version' })).toBeInTheDocument();
  });

  it('does NOT show "Create new version" for a non-spec docType', async () => {
    tagAc(AC(33));
    mockDoc = makeDoc({ docType: 'document', status: 'draft' });
    const user = userEvent.setup();
    renderAt('/n/m/docs/doc-448');

    await screen.findByText('Document versioning');
    const menuButton = await screen.findByRole('button', { name: /Actions for Document versioning/i });
    await user.click(menuButton);

    expect(screen.queryByRole('menuitem', { name: 'Create new version' })).not.toBeInTheDocument();
  });

  it('does NOT show the version-history switcher for a non-spec docType', async () => {
    mockDoc = makeDoc({ docType: 'document', status: 'draft' });
    renderAt('/n/m/docs/doc-448');

    await screen.findByText('Document versioning');
    expect(screen.queryByTestId('version-switcher-trigger')).not.toBeInTheDocument();
  });
});
