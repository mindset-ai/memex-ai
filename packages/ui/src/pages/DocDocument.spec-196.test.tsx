// spec-196 t-1 — the Specify sub-tab label "Narrative" → "Spec".
//
// dec-1: the rename is UI-label-only. The tab READS "Spec" (the prose sections
// ARE the spec) while its id stays 'narrative' — internal vocabulary, deep
// links, and comment routing are deliberately unchanged.
//
//   ac-1 : the sub-tab reads "Spec"; "Narrative" no longer appears in the UI.
//   ac-5 : deep links / routing to the narrative tab keep working.
//   ac-6 : label "Spec", id 'narrative' — both pinned.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import type { DocWithGraph } from '../api/types';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-196/acs/ac-${n}`;

// ── Heavy children → identity markers (same trim as the spec-159 suite) ─────
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
  SectionCard: () => <div data-testid="section-card" />,
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
// NB: refetch must be a STABLE identity — an inline `vi.fn()` here mints a new
// function per render, which feeds an effect → header-slot → re-render loop
// that runs the page to OOM the moment any click re-renders it.
const refetchRole = vi.fn();
vi.mock('../hooks/useDocRole', () => ({
  useDocRole: () => ({ myRole: 'editor', editors: [], loading: false, refetch: refetchRole }),
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

// Mutable fixtures: t-2's staleness tests shape the decisions graph and the
// consolidation timestamp per test (the staleness signal compares the two).
let docDecisions: unknown[] = [];
let docAcs: unknown[] = [];
let docNarrativeConsolidatedAt: string | null = null;

function resolvedDecision(id: string, resolvedAt: string) {
  return {
    id,
    docId: 'doc-uuid',
    seq: 1,
    title: id,
    context: null,
    status: 'resolved',
    resolution: 'done',
    resolvedAt,
    createdAt: '2026-06-01T00:00:00Z',
    options: null,
    chosenOptionIndex: null,
  };
}

function makeDoc(): DocWithGraph {
  return {
    id: 'doc-uuid',
    handle: 'spec-196',
    title: 'Rename test fixture',
    docType: 'spec',
    status: 'specify',
    creator: { name: 'Barrie', email: 'barrie@mindset.ai' },
    createdAt: '2026-06-01T00:00:00Z',
    statusChangedAt: '2026-06-04T00:00:00Z',
    narrativeLastConsolidatedAt: docNarrativeConsolidatedAt,
    sections: [{ id: 's-1', seq: 1, title: 'Intro', body: 'x' }],
    decisions: docDecisions,
    tasks: [],
    tags: [],
  } as unknown as DocWithGraph;
}

vi.mock('../api/client', () => ({
  NotFoundError: class NotFoundError extends Error {},
  fetchDoc: () => Promise.resolve(makeDoc()),
  fetchDocComments: () => Promise.resolve({ sections: [], decisions: [], tasks: [] }),
  fetchAcsForBrief: () => Promise.resolve(docAcs),
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

// The app shell's global header consumes the slot; without a sink the slot
// content has nowhere to land (same wiring as the spec-158/159 suites).
function HeaderSink() {
  return <div data-testid="header-slot">{useHeaderSlotContent()}</div>;
}

function renderAt(path = '/n/m/specs/spec-196') {
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
  docDecisions = [];
  docAcs = [];
  docNarrativeConsolidatedAt = null;
});

describe('spec-196 t-1 — Specify sub-tab reads "Spec", id stays narrative', () => {
  it('renders the sub-tab as "Spec"; "Narrative" appears nowhere; sections are the default view (ac-1, ac-6)', async () => {
    tagAc(AC(1));
    tagAc(AC(6));
    renderAt();

    // The first sub-tab reads "Spec".
    expect(await screen.findByRole('button', { name: 'Spec' })).toBeInTheDocument();
    // The old label is gone from the rendered UI.
    expect(screen.queryByText('Narrative')).not.toBeInTheDocument();
    // It's still the default sub-tab: the narrative (section cards) renders.
    expect(screen.getByTestId('section-card')).toBeInTheDocument();
  });

  it('the renamed tab still routes on the internal id — away to Decisions & ACs and back (ac-5, ac-6)', async () => {
    tagAc(AC(5));
    tagAc(AC(6));
    const user = userEvent.setup();
    renderAt();

    await screen.findByText('Spec');

    // Away: Decisions & ACs renders its two-column panels.
    await user.click(screen.getByText('Decisions & ACs'));
    expect(screen.getByTestId('decision-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('section-card')).not.toBeInTheDocument();

    // Back: the "Spec" tab routes to the narrative view via the unchanged
    // 'narrative' id (deep-link integrity itself is covered by the spec-158 /
    // spec-100 suites, which key on these ids, not labels).
    await user.click(screen.getByText('Spec'));
    expect(screen.getByTestId('section-card')).toBeInTheDocument();
  });

  it('stale narrative threads from the doc payload to the Rubicon; consolidation clears it (ac-9)', async () => {
    tagAc(AC(9));
    // A resolved decision NEWER than the consolidation timestamp → stale.
    docDecisions = [resolvedDecision('d-1', '2026-06-05T00:00:00Z')];
    docAcs = [{ ac: { id: 'ac-1', status: 'active' }, verificationState: 'verified' }];
    docNarrativeConsolidatedAt = '2026-06-02T00:00:00Z';
    const { unmount } = renderAt();

    // waitFor: the aux AC fetch settles a tick after the sentence first
    // renders (until then the AC blocker shares the line).
    const sentence = await screen.findByTestId('transition-sentence');
    await waitFor(() =>
      expect(sentence.textContent).toContain(
        'The spec narrative must be updated to reflect the resolved decisions before this spec can move to Build — use the refresh action to generate the update prompt.',
      ),
    );
    expect(sentence.textContent).not.toContain('Acceptance Criteria');
    expect(sentence.textContent).not.toContain('Do you wish');

    // The in-situ phase directive on Decisions & ACs mirrors the Rubicon copy.
    const user = userEvent.setup();
    await user.click(screen.getByText('Decisions & ACs'));
    expect(screen.getByTestId('phase-directive').textContent).toContain(
      'The spec narrative must be updated to reflect the resolved decisions before this spec can move to Build — use the refresh action to generate the update prompt.',
    );
    unmount();

    // Consolidation refreshed past the decision → the advancement offer.
    docNarrativeConsolidatedAt = '2026-06-06T00:00:00Z';
    renderAt();
    const fresh = await screen.findByTestId('transition-sentence');
    expect(fresh.textContent).toContain('Do you wish to move this spec to Build?');
  });

  it("source pins the pair: label 'Spec' with id 'narrative' (ac-6)", () => {
    tagAc(AC(6));
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'DocDocument.tsx'),
      'utf8',
    );
    // dec-1: the label renames, the id does not. A drive-by "consistency"
    // rename of the id would break deep links and comment routing — fail here.
    expect(src).toMatch(/id:\s*'narrative',\s*label:\s*'Spec'/);
    expect(src).not.toMatch(/label:\s*'Narrative'/);
  });
});
