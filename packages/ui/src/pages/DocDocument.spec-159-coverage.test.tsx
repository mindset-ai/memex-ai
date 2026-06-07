// spec-159 — DocDocument coverage gaps (kept in a SEPARATE file from
// DocDocument.spec-159.test.tsx so two agents can work the same page without
// colliding). Reuses the same heavy-child / hook / API-client mock scaffolding.
//
// What this file pins that the sibling file doesn't:
//   • the ZERO-STATE in-situ directives at the page level — a `build` with no
//     tasks and a `verify` with no active ACs each surface the "must be created
//     and …" ⚠ hole directive (the same holes the Rubicon line blocks on), and
//     these depend on the async AC/task sets resolving, so they exercise the
//     fetch race the sibling file's flake fix is about. [ac-13]
//   • the Rubicon line itself states those zero-state holes with NO buttons. [ac-3, ac-13]
//   • a blocked CURRENT phase withholds Yes at the page level even for an editor
//     (canTransition is true but the rubric is dirty → no buttons). [ac-3]

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import type { DocWithGraph } from '../api/types';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-159/acs/ac-${n}`;

vi.mock('../components/DecisionPanel', () => ({
  DecisionPanel: () => <div data-testid="decision-panel" />,
}));
vi.mock('../components/AcPanel', () => ({ AcPanel: () => <div data-testid="ac-panel" /> }));
vi.mock('../components/TaskPanel', () => ({ TaskPanel: () => <div data-testid="task-panel" /> }));
vi.mock('../components/IssuePanel', () => ({ IssuePanel: () => <div data-testid="issue-panel" /> }));
vi.mock('../components/AllComments', () => ({ AllComments: () => <div data-testid="all-comments" /> }));
vi.mock('../components/SectionCard', () => ({ SectionCard: () => <div data-testid="section-card" /> }));
vi.mock('../components/DocOutline', () => ({ DocOutline: () => <div data-testid="doc-outline" /> }));
vi.mock('../components/TagPicker', () => ({ TagPicker: () => null }));
// spec-159: assignment lives on the byline; the SpecRoleControls row left the page.
vi.mock('../components/BylineAssignees', () => ({
  BylineAssignees: () => <div data-testid="byline-assignees" />,
}));
vi.mock('../components/DoneSummary', () => ({ DoneSummary: () => <div data-testid="done-summary" /> }));

let mockRole: 'editor' | 'reviewer' = 'editor';
vi.mock('../hooks/useMemexAccess', () => ({
  useMemexAccess: () => ({ canWrite: true, isReadOnly: false }),
}));
vi.mock('../hooks/useDocRole', () => ({
  useDocRole: () => ({ myRole: mockRole, editors: [], loading: false, refetch: vi.fn() }),
}));
vi.mock('../hooks/useDocChangeStream', () => ({ useDocChangeStream: () => {} }));
vi.mock('../hooks/useOrgScaffoldBlocks', () => ({ useOrgScaffoldBlocks: () => [] }));
vi.mock('../components/HeaderSlot', () => ({
  useHeaderSlot: () => {},
  useHeaderSlotContent: () => null,
}));
const chat = {
  setDocId: vi.fn(),
  setDoc: vi.fn(),
  setOpenCommentCount: vi.fn(),
  sendMessage: vi.fn(),
};
vi.mock('../components/ChatContext', () => ({ useChat: () => chat }));

const updateDocStatus = vi.fn();
let docStatus: DocWithGraph['status'] = 'specify';
let docDecisions: unknown[] = [];
let docTasks: unknown[] = [];
let docAcs: unknown[] = [];

function makeDoc(): DocWithGraph {
  return {
    id: 'doc-uuid',
    handle: 'spec-159',
    title: 'Phase tabs',
    docType: 'spec',
    status: docStatus,
    creator: { name: 'Barrie', email: 'barrie@mindset.ai' },
    createdAt: '2026-06-01T00:00:00Z',
    statusChangedAt: '2026-06-04T00:00:00Z',
    narrativeLastConsolidatedAt: null,
    sections: [{ id: 's-1', seq: 1, title: 'Intro', body: 'x' }],
    decisions: docDecisions,
    tasks: docTasks,
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
  updateDocStatus: (...a: unknown[]) => updateDocStatus(...a),
  // The header posture pill's switch path (unused in these directive tests,
  // but useSwitchPosture imports both).
  promoteToEditor: vi.fn(),
  demoteToReviewer: vi.fn(),
}));

import { DocDocument } from './DocDocument';

function renderAt(status: DocWithGraph['status'], path = '/n/m/specs/spec-159') {
  docStatus = status;
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/:ns/:mx/specs/:id" element={<DocDocument />} />
      </Routes>
    </MemoryRouter>,
  );
}

function directiveText() {
  return screen
    .getAllByTestId('phase-directive')
    .map((d) => d.textContent)
    .join(' ');
}

beforeEach(() => {
  vi.clearAllMocks();
  updateDocStatus.mockResolvedValue(undefined);
  mockRole = 'editor';
  docDecisions = [];
  docTasks = [];
  docAcs = [];
});

describe('spec-159 — zero-state holes block at the page level (ac-3, ac-13)', () => {
  it('build with ZERO tasks: in-situ ⚠ directive states the hole; Rubicon line blocks with no buttons', async () => {
    tagAc(AC(3));
    tagAc(AC(13));
    // No tasks at all — the zero-task hole (an empty build hasn't built anything).
    docTasks = [];
    renderAt('build');

    await screen.findByTestId('task-panel');
    // The in-situ directive sits above the Tasks column.
    await waitFor(() =>
      expect(directiveText()).toContain(
        'Tasks must be created and completed before this spec can move to Verify.',
      ),
    );
    // The Rubicon line states the same hole and offers nothing to press.
    const sentence = screen.getByTestId('transition-sentence');
    expect(sentence.textContent).toContain(
      'Tasks must be created and completed before this spec can move to Verify.',
    );
    expect(within(sentence).queryByRole('button')).not.toBeInTheDocument();
  });

  it('verify with NO active ACs: in-situ ⚠ directive states the hole; Rubicon line blocks with no buttons', async () => {
    tagAc(AC(3));
    tagAc(AC(13));
    // No active ACs — nothing to verify against (the verify→done hole).
    docAcs = [];
    renderAt('verify');

    await screen.findByTestId('ac-panel');
    await waitFor(() =>
      expect(directiveText()).toContain(
        'Acceptance Criteria (ACs) must be created and verified before this spec can move to Done.',
      ),
    );
    const sentence = screen.getByTestId('transition-sentence');
    expect(sentence.textContent).toContain(
      'Acceptance Criteria (ACs) must be created and verified before this spec can move to Done.',
    );
    expect(within(sentence).queryByRole('button')).not.toBeInTheDocument();
  });

  it('an inactive (non-active) AC does NOT satisfy the verify hole — still blocked', async () => {
    tagAc(AC(13));
    // Only a retired/inactive AC exists → no ACTIVE AC, so the hole stands even
    // though the fetch returns a row. (hasAcceptanceCriteria counts active only.)
    docAcs = [{ ac: { status: 'retired' }, verificationState: 'verified' }];
    renderAt('verify');

    await screen.findByTestId('ac-panel');
    await waitFor(() =>
      expect(directiveText()).toContain(
        'Acceptance Criteria (ACs) must be created and verified before this spec can move to Done.',
      ),
    );
  });
});

describe('spec-159 — blocked current phase withholds Yes for an editor (ac-3)', () => {
  it('editor on a dirty plan (open decision): the line states the blocker, no Yes', async () => {
    tagAc(AC(3));
    mockRole = 'editor';
    docDecisions = [
      {
        id: 'd-1',
        docId: 'doc-uuid',
        seq: 1,
        title: 'd-1',
        context: null,
        status: 'open',
        resolution: null,
        resolvedAt: null,
        createdAt: '2026-06-01T00:00:00Z',
        options: null,
        chosenOptionIndex: null,
      },
    ];
    docAcs = [{ ac: { status: 'active' }, verificationState: 'verified' }];
    renderAt('specify');

    const sentence = await screen.findByTestId('transition-sentence');
    // Even with an editor posture (canTransition true) a dirty rubric on the
    // current tab shows the condition, never a Yes.
    await waitFor(() =>
      expect(sentence.textContent).toContain(
        '1 Decision must be resolved before this spec can move to Build.',
      ),
    );
    expect(within(sentence).queryByRole('button')).not.toBeInTheDocument();
  });
});
