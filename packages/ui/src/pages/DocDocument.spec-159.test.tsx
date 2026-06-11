// spec-159 t-6 — the Spec page is reorganised around the three working phases.
// These tests render the REAL DocDocument with its heavy panels / hooks / API
// stubbed to lightweight markers, then assert the per-phase layout, the sub-tab
// presence/absence, and the two behavioural invariants (browsing never moves
// the phase; the only phase mutation is the in-page sentence's [Yes] — no
// modal, no PhaseDropdown).
//
//   ac-5  : each phase renders the right panels / columns.
//   ac-10 : Specify has three sub-tabs incl. the two-column Decisions & ACs.
//   ac-11 : Build / Verify carry no sub-tab bar.
//   ac-15 : browsing a non-current tab doesn't change the phase; the current-
//           phase highlight persists.
//   ac-1  : no PhaseDropdown / no other phase-control affordance survives.
//   ac-6  : the transition flow mounts no modal — Yes transitions directly.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import type { ReactNode } from 'react';
import type { DocWithGraph } from '../api/types';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-159/acs/ac-${n}`;

// ── Heavy children → identity markers so we can see which panel rendered ────
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
// spec-159: assignment lives on the byline; the SpecRoleControls row left the page.
vi.mock('../components/BylineAssignees', () => ({
  BylineAssignees: () => <div data-testid="byline-assignees" />,
}));
vi.mock('../components/DoneSummary', () => ({
  // spec-164 dec-5: the stub surfaces the reopen wiring so the page-level
  // tests can assert DocDocument threads canReopen (editor posture) and that
  // onReopen performs the verify status write.
  DoneSummary: (props: { canReopen?: boolean; onReopen?: () => void }) => (
    <div data-testid="done-summary" data-can-reopen={props.canReopen ? 'true' : 'false'}>
      {props.canReopen && (
        <button data-testid="stub-reopen" onClick={() => props.onReopen?.()}>
          reopen
        </button>
      )}
    </div>
  ),
}));

// ── Hooks: write access + a configurable posture (i-1: the sentence renders
//    for reviewers too; only the Yes gates on editor posture) ────────────────
let mockRole: 'editor' | 'reviewer' = 'editor';
const refetchRole = vi.fn();
vi.mock('../hooks/useMemexAccess', () => ({
  useMemexAccess: () => ({ canWrite: true, isReadOnly: false }),
}));
vi.mock('../hooks/useDocRole', () => ({
  useDocRole: () => ({ myRole: mockRole, editors: [], loading: false, refetch: refetchRole }),
}));
vi.mock('../hooks/useDocChangeStream', () => ({ useDocChangeStream: () => {} }));
// ac-17: the handoff line's PromptButton resolves Org appends via this hook
// (which would otherwise reach AuthContext) — stub it to no Org appends.
vi.mock('../hooks/useOrgScaffoldBlocks', () => ({ useOrgScaffoldBlocks: () => [] }));
// The REAL HeaderSlot: the posture pill (PostureDropdown) renders through the
// header slot, so renderAt mounts the provider plus a sink that renders the
// slot content — the same wiring the app shell provides.
const chat = {
  setDocId: vi.fn(),
  setDoc: vi.fn(),
  setOpenCommentCount: vi.fn(),
  sendMessage: vi.fn(),
};
vi.mock('../components/ChatContext', () => ({ useChat: () => chat }));

// ── API client: doc + the page-level AC/issue/assignee/comment fetches ──────
const updateDocStatus = vi.fn();
let docStatus: DocWithGraph['status'] = 'specify';
// Mutable graph fixtures so each test can shape the in-situ directive inputs
// (open decisions / open tasks / unverified ACs).
let docDecisions: unknown[] = [];
let docTasks: unknown[] = [];
let docAcs: unknown[] = [];

function decision(id: string, status: 'open' | 'resolved') {
  return {
    id,
    docId: 'doc-uuid',
    seq: 1,
    title: id,
    context: null,
    status,
    resolution: status === 'resolved' ? 'done' : null,
    resolvedAt: status === 'resolved' ? '2026-06-02T00:00:00Z' : null,
    createdAt: '2026-06-01T00:00:00Z',
    options: null,
    chosenOptionIndex: null,
  };
}

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

const promoteToEditor = vi.fn();
const demoteToReviewer = vi.fn();
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
  // spec-159 ac-19 (amended): the header posture pill → useSwitchPosture calls
  // promoteToEditor / demoteToReviewer, then refetches the role.
  promoteToEditor: (...a: unknown[]) => promoteToEditor(...a),
  demoteToReviewer: (...a: unknown[]) => demoteToReviewer(...a),
}));

import { DocDocument } from './DocDocument';
import { HeaderSlotProvider, useHeaderSlotContent } from '../components/HeaderSlot';

// Renders the header-slot content the way the app shell's global header does,
// so the posture pill is reachable in these tests.
function HeaderSink() {
  return <div data-testid="header-slot">{useHeaderSlotContent()}</div>;
}

function renderAt(status: DocWithGraph['status'], path = '/n/m/specs/spec-159') {
  docStatus = status;
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

function phaseTab(name: string) {
  return screen.getAllByRole('tab').find((t) => t.getAttribute('data-tab') === name)!;
}

beforeEach(() => {
  vi.clearAllMocks();
  updateDocStatus.mockResolvedValue(undefined);
  promoteToEditor.mockResolvedValue(undefined);
  demoteToReviewer.mockResolvedValue(undefined);
  mockRole = 'editor';
  docDecisions = [];
  docTasks = [];
  docAcs = [];
});

describe('spec-159 t-6 — DocDocument phase layouts', () => {
  // spec-159: assignment lives on the byline; the SpecRoleControls row left the page.
  it('renders the byline assignment for a Spec; the SpecRoleControls row is gone (ac-21)', async () => {
    tagAc(AC(21));
    renderAt('specify');
    // The byline assignment mounts for a Spec doc.
    expect(await screen.findByTestId('byline-assignees')).toBeInTheDocument();
    // The old posture/assignment row no longer renders on the page.
    expect(screen.queryByTestId('spec-role-controls')).not.toBeInTheDocument();
  });

  it('Specify renders three sub-tabs; Decisions & ACs is a two-column Decision | AC layout (ac-5, ac-10)', async () => {
    tagAc(AC(5));
    tagAc(AC(10));
    const user = userEvent.setup();
    renderAt('specify');

    // Specify view is current → its sub-tab bar shows Spec / Decisions & ACs / Comments.
    await screen.findByText('Narrative');
    expect(screen.getByText('Decisions & ACs')).toBeInTheDocument();
    expect(screen.getByText('Comments')).toBeInTheDocument();

    // Default sub-tab is Spec (the narrative) (section cards render).
    expect(screen.getByTestId('section-card')).toBeInTheDocument();

    // Switch to Decisions & ACs → both panels render side by side.
    await user.click(screen.getByText('Decisions & ACs'));
    expect(screen.getByTestId('decision-panel')).toBeInTheDocument();
    expect(screen.getByTestId('ac-panel')).toBeInTheDocument();

    // Comments sub-tab → AllComments.
    await user.click(screen.getByText('Comments'));
    expect(screen.getByTestId('all-comments')).toBeInTheDocument();
  });

  it('Build renders Tasks | Issues with NO sub-tab bar (ac-5, ac-11)', async () => {
    tagAc(AC(5));
    tagAc(AC(11));
    renderAt('build');

    await screen.findByTestId('task-panel');
    expect(screen.getByTestId('issue-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('ac-panel')).not.toBeInTheDocument();

    // No sub-tab bar: the Specify sub-tab labels are absent.
    expect(screen.queryByText('Decisions & ACs')).not.toBeInTheDocument();
    // The only tablist on the page is the phase bar (3 tabs), not a sub-tab bar.
    expect(screen.getAllByRole('tab')).toHaveLength(3);
  });

  it('Verify renders AC | Issues with NO sub-tab bar (ac-5, ac-11)', async () => {
    tagAc(AC(5));
    tagAc(AC(11));
    renderAt('verify');

    await screen.findByTestId('ac-panel');
    expect(screen.getByTestId('issue-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('task-panel')).not.toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
  });

  it('Done replaces the content area with the DoneSummary report (ac-5)', async () => {
    tagAc(AC(5));
    renderAt('done');

    await screen.findByTestId('done-summary');
    // No phase tab bar / sub-tabs / working panels in the done report.
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.queryByTestId('task-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('decision-panel')).not.toBeInTheDocument();
  });

  it('browsing a non-current tab changes the view but never the phase (ac-15)', async () => {
    tagAc(AC(15));
    const user = userEvent.setup();
    renderAt('build');

    await screen.findByTestId('task-panel');
    // build is the current phase.
    expect(phaseTab('build')).toHaveAttribute('data-current', 'true');

    // Browse the Verify view.
    await user.click(phaseTab('verify'));

    // The view switched (AC | Issues now render)…
    expect(screen.getByTestId('ac-panel')).toBeInTheDocument();
    // …but the current-phase highlight is STILL on build, and no status mutation fired.
    expect(phaseTab('build')).toHaveAttribute('data-current', 'true');
    expect(phaseTab('verify')).not.toHaveAttribute('data-current');
    expect(phaseTab('verify')).toHaveAttribute('data-selected', 'true');
    expect(updateDocStatus).not.toHaveBeenCalled();
  });

  it('mounts no PhaseDropdown and no other phase-control affordance (ac-1)', async () => {
    tagAc(AC(1));
    renderAt('specify');
    await screen.findByText('Narrative');

    // No listbox-style phase dropdown trigger anywhere.
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Spec phase: .*Click to change/i)).not.toBeInTheDocument();
    // The single phase affordance is the transition sentence.
    expect(screen.getByTestId('transition-sentence')).toBeInTheDocument();
  });

  it('the transition flow mounts no modal — Yes calls updateDocStatus directly (ac-6)', async () => {
    tagAc(AC(6));
    const user = userEvent.setup();
    // verify → done is a forward step; with every active AC verified it offers
    // Yes (an AC-less verify is blocked — covered in the Rubicon describe).
    docAcs = [{ ac: { status: 'active' }, verificationState: 'verified' }];
    renderAt('verify');
    await screen.findByTestId('ac-panel');

    const sentence = screen.getByTestId('transition-sentence');
    const yes = await within(sentence).findByRole('button', { name: 'Yes' });
    await user.click(yes);

    // Directly transitioned — no confirm dialog was ever mounted.
    await waitFor(() => expect(updateDocStatus).toHaveBeenCalledWith('doc-uuid', 'done'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

// dec-4, second amendment (the Rubicon line): the sentence always states the
// rubric's exact condition. Current tab + blocked → summary with NO buttons;
// browsing forward → summary + Are-you-sure Yes/No. The in-situ ⚠ directives
// above the lists are unchanged.
describe('spec-159 — Rubicon line + in-situ directives', () => {
  it('specify with open decisions: line states the blocker with no buttons; directive sits above Decisions (ac-3, ac-13)', async () => {
    tagAc(AC(3));
    tagAc(AC(13));
    const user = userEvent.setup();
    docDecisions = [decision('d-1', 'open'), decision('d-2', 'open')];
    docAcs = [{ ac: { status: 'active' }, verificationState: 'untested' }];
    renderAt('specify');

    // Current tab + blocked rubric → the exact condition, no Yes to press.
    // (waitFor: the AC fetch resolving flips `hasAcceptanceCriteria` async.)
    const sentence = await screen.findByTestId('transition-sentence');
    await waitFor(() =>
      expect(sentence.textContent).toContain(
        '2 Decisions must be resolved before this spec can move to Build.',
      ),
    );
    expect(within(sentence).queryByRole('button')).not.toBeInTheDocument();

    // The directive renders in-situ on the Decisions & ACs sub-tab.
    await user.click(screen.getByText('Decisions & ACs'));
    const directives = screen.getAllByTestId('phase-directive');
    expect(directives.map((d) => d.textContent).join(' ')).toContain(
      '2 Decisions must be resolved before this spec can move to Build.',
    );
  });

  it('forward browse while blocked: shortened summary + Are-you-sure Yes/No; No returns to the current tab (ac-13, ac-16)', async () => {
    tagAc(AC(13));
    tagAc(AC(16));
    const user = userEvent.setup();
    docDecisions = [decision('d-1', 'open')];
    renderAt('specify');
    await screen.findByText('Narrative');

    await user.click(phaseTab('build'));
    const sentence = screen.getByTestId('transition-sentence');
    expect(sentence.textContent).toContain(
      '1 Decision must be resolved and Acceptance Criteria (ACs) must be created before Build.',
    );
    // The summary already names the target — the question doesn't repeat it.
    expect(sentence.textContent).toContain('Move this spec anyway?');

    // No → back to the current phase's view, no phase mutation.
    await user.click(within(sentence).getByRole('button', { name: 'No' }));
    expect(phaseTab('specify')).toHaveAttribute('data-selected', 'true');
    expect(screen.getByText('Narrative')).toBeInTheDocument();
    expect(updateDocStatus).not.toHaveBeenCalled();
  });

  it('specify with no decisions and no ACs: ONE full-width directive concatenates both fragments (ac-13, ac-14)', async () => {
    tagAc(AC(13));
    tagAc(AC(14));
    const user = userEvent.setup();
    renderAt('specify');
    await screen.findByText('Decisions & ACs');
    await user.click(screen.getByText('Decisions & ACs'));

    // The directive spans the two-column grid as a single line above it;
    // same-verb fragments merge their entities ("Decisions and ACs must be
    // created…") so the columns always start top-aligned.
    const directives = screen.getAllByTestId('phase-directive');
    expect(directives).toHaveLength(1);
    expect(directives[0]!.textContent).toContain(
      'Decisions and Acceptance Criteria (ACs) must be created before this spec can move to Build.',
    );
  });

  it('open-decision count follows the shared countUnresolvedDecisions semantics (ac-14)', async () => {
    tagAc(AC(14));
    const user = userEvent.setup();
    // 2 open + 1 resolved → the shared count is 2, not 3.
    docDecisions = [decision('d-1', 'open'), decision('d-2', 'open'), decision('d-3', 'resolved')];
    docAcs = [{ ac: { status: 'active' }, verificationState: 'verified' }];
    renderAt('specify');
    await screen.findByText('Decisions & ACs');
    await user.click(screen.getByText('Decisions & ACs'));

    const text = screen
      .getAllByTestId('phase-directive')
      .map((d) => d.textContent)
      .join(' ');
    expect(text).toContain('2 Decisions must be resolved before this spec can move to Build.');
  });

  it('build with open tasks: directive above Tasks; Rubicon line states it with no buttons (ac-13)', async () => {
    tagAc(AC(13));
    docTasks = [{ id: 't-1', status: 'in_progress' }, { id: 't-2', status: 'complete' }];
    renderAt('build');

    await screen.findByTestId('task-panel');
    const text = screen
      .getAllByTestId('phase-directive')
      .map((d) => d.textContent)
      .join(' ');
    expect(text).toContain(
      '1 Task must be completed (or kicked to Issues) before this spec can move to Verify.',
    );
    // Current tab + open task → the Rubicon line states it, no buttons.
    const sentence = screen.getByTestId('transition-sentence');
    expect(sentence.textContent).toContain(
      '1 Task must be completed before this spec can move to Verify.',
    );
    expect(within(sentence).queryByRole('button')).not.toBeInTheDocument();
  });

  it('verify with unverified ACs: directive above the AC column (ac-13)', async () => {
    tagAc(AC(13));
    docAcs = [
      { ac: { status: 'active' }, verificationState: 'untested' },
      { ac: { status: 'active' }, verificationState: 'verified' },
    ];
    renderAt('verify');

    await screen.findByTestId('ac-panel');
    // waitFor: the AC fetch resolving flips `unverifiedAcCount` from 0 → 1 async;
    // before it resolves the directive reads "must be created and verified" (the
    // zero-AC hole), not the unverified-count line (i-2 race).
    await waitFor(() => {
      const text = screen
        .getAllByTestId('phase-directive')
        .map((d) => d.textContent)
        .join(' ');
      expect(text).toContain(
        '1 Acceptance Criterion (AC) must be verified before this spec can move to Done.',
      );
    });
  });

  it('directives belong to the CURRENT phase only — browsing another layout shows none (ac-13)', async () => {
    tagAc(AC(13));
    const user = userEvent.setup();
    // Current phase specify (with open decisions); browse the Build layout —
    // the build directive must NOT fire (its gate is about specify→build, not
    // the browsed view).
    docDecisions = [decision('d-1', 'open')];
    docTasks = [{ id: 't-1', status: 'in_progress' }];
    renderAt('specify');
    await screen.findByText('Narrative');

    await user.click(phaseTab('build'));
    await screen.findByTestId('task-panel');
    expect(screen.queryAllByTestId('phase-directive')).toHaveLength(0);
  });

  it('pressing Yes moves the view with the phase — the new phase tab becomes current AND selected (ac-15)', async () => {
    tagAc(AC(15));
    const user = userEvent.setup();
    // Spec in build; the user browses back to the Specify tab, then accepts the
    // backward offer. After the move the view must follow: Specify is the new
    // current phase's home tab and the layout shows Specify's content — not the
    // stale browsed pin.
    renderAt('build');
    await screen.findByTestId('task-panel');

    await user.click(phaseTab('specify'));
    await screen.findByText('Narrative');
    expect(phaseTab('build')).toHaveAttribute('data-current', 'true');

    // The refetch after the transition returns the moved doc.
    docStatus = 'specify';
    const sentence = screen.getByTestId('transition-sentence');
    await user.click(within(sentence).getByRole('button', { name: 'Yes' }));

    await waitFor(() => expect(updateDocStatus).toHaveBeenCalledWith('doc-uuid', 'specify'));
    // The current-phase pill AND the selection both land on Specify.
    await waitFor(() => expect(phaseTab('specify')).toHaveAttribute('data-current', 'true'));
    expect(phaseTab('specify')).toHaveAttribute('data-selected', 'true');
    expect(phaseTab('build')).not.toHaveAttribute('data-current');
    // Specify's layout renders (sub-tabs visible).
    expect(screen.getByText('Decisions & ACs')).toBeInTheDocument();
  });

  it('editor keeps the phase block — tabs + the Rubicon transition sentence (ac-19)', async () => {
    tagAc(AC(19));
    mockRole = 'editor';
    renderAt('specify');
    await screen.findByText('Narrative');

    // Editors still get the PhaseTabBar (3 phase tabs) and the Rubicon line.
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(screen.getByTestId('transition-sentence')).toBeInTheDocument();
    // spec-182 dec-3 + issue-3: at Specify the editor keeps ACCESS to the
    // review actions, but behind a collapsed-by-default disclosure.
    expect(screen.getByTestId('review-actions-toggle')).toBeInTheDocument();
    expect(screen.queryByTestId('review-action-row')).not.toBeInTheDocument();
  });

  // spec-182 issue-3 — the editor's Specify view was visually dominated by the
  // reviewer workflow (four review buttons + two handoff lines). The user's
  // call (2026-06-05): collapse, don't remove — editors keep dec-3's access
  // behind a "Review actions" disclosure; reviewers see it expanded, no chrome.
  it('editor at Specify: the disclosure expands to the review row + review handoff, and collapses again (issue-3)', async () => {
    tagAc(AC182(10));
    tagAc(AC182(11));
    mockRole = 'editor';
    const user = userEvent.setup();
    renderAt('specify');

    const toggle = await screen.findByTestId('review-actions-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('review-action-row')).not.toBeInTheDocument();
    expect(screen.queryByTestId('review-handoff-line')).not.toBeInTheDocument();
    // The editor's own phase handoff is NOT behind the disclosure.
    expect(screen.getByTestId('phase-handoff-line')).toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('review-action-row')).toBeInTheDocument();
    expect(screen.getByTestId('review-handoff-line')).toBeInTheDocument();

    await user.click(toggle);
    expect(screen.queryByTestId('review-action-row')).not.toBeInTheDocument();
    expect(screen.queryByTestId('review-handoff-line')).not.toBeInTheDocument();
  });
});

// spec-182 dec-1/dec-2/dec-3 — the spec-159 ac-19 reviewer block is DISSOLVED.
// A writable reviewer gets the same page as everyone: full phase tab bar
// (browse-only), the status-only Rubicon line, and — at Specify only, for both
// postures — the review-action row + review handoff. The posture itself still
// lives in the header's PostureDropdown pill (bidirectional).
const AC182 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-182/acs/ac-${n}`;

describe('spec-182 — unified reviewer phase block', () => {
  beforeEach(() => {
    mockRole = 'reviewer';
  });

  it('a reviewer gets the full phase tab bar and the status-only transition sentence', async () => {
    tagAc(AC182(7));
    tagAc(AC182(9));
    tagAc('mindset-prod/memex-building-itself/specs/spec-182/acs/ac-1');
    tagAc('mindset-prod/memex-building-itself/specs/spec-182/acs/ac-2');
    renderAt('specify');

    await screen.findByTestId('review-action-row');
    // The PhaseTabBar renders for reviewers too (dec-1) — browse-only.
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    // The Rubicon line renders status-only: present, but no [Yes] (dec-2).
    const sentence = screen.getByTestId('transition-sentence');
    expect(within(sentence).queryByRole('button', { name: 'Yes' })).not.toBeInTheDocument();
    // issue-3: the collapse disclosure is editor chrome — reviewers get the
    // row expanded directly, no toggle.
    expect(screen.queryByTestId('review-actions-toggle')).not.toBeInTheDocument();
  });

  it('header pill reads "You are reviewing"; picking Editing promotes to editor', async () => {
    tagAc(AC(19));
    const user = userEvent.setup();
    renderAt('specify');
    await screen.findByTestId('review-action-row');

    // The pill renders in the header slot, not the page body — and the old
    // posture sentence is gone. findByRole: the slot populates via a
    // useHeaderSlot effect a tick after the body renders (same async class
    // as i-2 / the editor-pill variant below).
    const header = screen.getByTestId('header-slot');
    const pill = await within(header).findByRole('button', { name: /You are reviewing/ });
    expect(screen.queryByText(/You are a reviewer of this spec/)).not.toBeInTheDocument();

    await user.click(pill);
    await user.click(screen.getByRole('menuitemradio', { name: /Editing/ }));
    // useSwitchPosture → promoteToEditor(docId) then a role refetch.
    await waitFor(() => expect(promoteToEditor).toHaveBeenCalledWith('doc-uuid'));
    expect(demoteToReviewer).not.toHaveBeenCalled();
    expect(refetchRole).toHaveBeenCalled();
  });

  it('editor: header pill reads "You are editing"; picking Reviewing demotes to reviewer', async () => {
    tagAc(AC(19));
    mockRole = 'editor';
    const user = userEvent.setup();
    renderAt('specify');
    await screen.findByText('Narrative');

    const header = screen.getByTestId('header-slot');
    // findByRole: the header slot populates via a useHeaderSlot effect a tick
    // after the page body renders — under full-suite load the pill can land
    // after 'Spec' is already visible (same async class as i-2).
    await user.click(await within(header).findByRole('button', { name: /You are editing/ }));
    await user.click(screen.getByRole('menuitemradio', { name: /Reviewing/ }));
    // useSwitchPosture → demoteToReviewer(docId) then a role refetch.
    await waitFor(() => expect(demoteToReviewer).toHaveBeenCalledWith('doc-uuid'));
    expect(promoteToEditor).not.toHaveBeenCalled();
    expect(refetchRole).toHaveBeenCalled();
  });

  it('renders the four review-action buttons; clicking one sends the scaffold prompt through chat', async () => {
    tagAc(AC182(10));
    tagAc(AC182(11));
    tagAc(AC182(3));
    const user = userEvent.setup();
    renderAt('specify');

    const row = await screen.findByTestId('review-action-row');
    for (const label of ['Summarise Spec', 'Security review', 'Design review', 'Architecture review']) {
      expect(within(row).getByRole('button', { name: label })).toBeInTheDocument();
    }

    await user.click(within(row).getByRole('button', { name: 'Security review' }));
    expect(chat.sendMessage).toHaveBeenCalledTimes(1);
    const prompt = chat.sendMessage.mock.calls[0][0] as string;
    // Non-empty prose resolved from the scaffold, interpolated with the Spec's
    // own context (the handle appears in the security-review prompt's body? it
    // references the Spec generically — assert it's a real, non-trivial string).
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(20);
    expect(prompt).toContain('security');
  });

  it('renders the reviewer handoff line — "Copy the review prompt …conduct the review from there."', async () => {
    tagAc(AC182(11));
    renderAt('specify');

    const line = await screen.findByTestId('review-handoff-line');
    expect(line.textContent).toContain(
      'Copy the review prompt into your coding agent if you prefer to conduct the review from there.',
    );
    // issue-4: the clickable words LEAD the line and NAME the prompt, so
    // adjacent handoff lines are distinguishable from the link text alone.
    const copyButton = within(line).getByRole('button', {
      name: /^Copy the review prompt/,
    });
    expect(copyButton.textContent).toBe('Copy the review prompt');
    // spec-182 issue-2: the phase handoff is an editor affordance — its prompt
    // drives state changes and building. A reviewer gets the review handoff
    // ONLY (amends ac-17's "renders for every viewer").
    expect(screen.queryByTestId('phase-handoff-line')).not.toBeInTheDocument();
  });

  it('a reviewer at Build sees NO coding-agent handoff line (issue-2)', async () => {
    tagAc(AC182(17));
    renderAt('build');

    await screen.findByTestId('task-panel');
    expect(screen.queryByTestId('phase-handoff-line')).not.toBeInTheDocument();
    expect(screen.queryByTestId('review-handoff-line')).not.toBeInTheDocument();
  });

  it('a reviewer at Verify sees NO coding-agent handoff line (issue-2)', async () => {
    tagAc(AC182(17));
    renderAt('verify');

    await screen.findByTestId('ac-panel');
    expect(screen.queryByTestId('phase-handoff-line')).not.toBeInTheDocument();
  });

  it('build: tabs render, panels render, and NO review actions outside Specify', async () => {
    tagAc(AC182(10));
    tagAc(AC182(3));
    renderAt('build');

    await screen.findByTestId('task-panel');
    expect(screen.getByTestId('issue-panel')).toBeInTheDocument();
    // dec-1: the tab bar renders for reviewers; dec-3: no review row off-Specify.
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(screen.queryByTestId('review-action-row')).not.toBeInTheDocument();
    expect(screen.queryByTestId('review-handoff-line')).not.toBeInTheDocument();
  });

  it('draft shows NO review actions either — the row is Specify-only (dec-3)', async () => {
    tagAc(AC182(10));
    tagAc(AC182(3));
    renderAt('draft');

    await screen.findByText('Narrative');
    expect(screen.queryByTestId('review-action-row')).not.toBeInTheDocument();
    expect(screen.queryByTestId('review-handoff-line')).not.toBeInTheDocument();
  });

  it('a reviewer browses another phase without moving the spec (ac-8)', async () => {
    tagAc(AC182(8));
    const user = userEvent.setup();
    renderAt('build');

    await screen.findByTestId('task-panel');
    // Click the Verify tab — the verify layout renders, the phase is untouched.
    await user.click(screen.getAllByRole('tab').find((t) => t.getAttribute('data-tab') === 'verify')!);
    await screen.findByTestId('ac-panel');
    expect(updateDocStatus).not.toHaveBeenCalled();
  });

  it("the reviewer's sentence is a clean status line — no switch-to-Editing nag (dec-6 amended)", async () => {
    tagAc(AC182(14));
    tagAc(AC182(6));
    renderAt('specify');

    const sentence = await screen.findByTestId('transition-sentence');
    expect(within(sentence).queryByTestId('switch-to-editing')).not.toBeInTheDocument();
    expect(sentence.textContent).not.toContain("You're reviewing");
  });

  it('done collapses to the DoneSummary for reviewers — no review block; Reopen is offered (spec-196)', async () => {
    tagAc(AC182(13));
    tagAc(AC182(5));
    // spec-196 ac-15: a writable reviewer sees Reopen at done (gate relaxed
    // from editor posture to org write access).
    tagAc('mindset-prod/memex-building-itself/specs/spec-196/acs/ac-15');
    renderAt('done');

    const summary = await screen.findByTestId('done-summary');
    expect(screen.queryByTestId('review-action-row')).not.toBeInTheDocument();
    expect(screen.queryByTestId('review-handoff-line')).not.toBeInTheDocument();
    // spec-196 relaxed spec-164 dec-5: Reopen now gates on org write access,
    // not editor posture, so a writable reviewer sees it (the reviewer/editor
    // distinction is meaningless on a closed spec). canWrite is true here.
    expect(summary).toHaveAttribute('data-can-reopen', 'true');
  });
});

// spec-159 ac-17 — the next-action handoff line beneath the Rubicon line. Keyed
// to the Spec's CURRENT phase, absent at `done`. spec-182 issue-2 amended
// ac-17's "renders for every viewer": the line is editor-only (canEdit) — its
// prompt drives state changes and building, which are not reviewer powers.
describe('spec-159 ac-17 — next-action handoff line', () => {
  it('specify: "Copy the Specify prompt into your coding agent to create Decisions and ACs." with bold entities', async () => {
    tagAc(AC(17));
    renderAt('specify');

    const line = await screen.findByTestId('phase-handoff-line');
    expect(line.textContent).toContain(
      'Copy the Specify prompt into your coding agent to create Decisions and ACs.',
    );
    // The entity names render bold (<strong>) — "ACs" abbreviated since the
    // Rubicon line above already spells it out in full.
    const bolded = Array.from(line.querySelectorAll('strong')).map((el) => el.textContent);
    expect(bolded).toContain('Decisions');
    expect(bolded).toContain('ACs');
    // issue-4: the clickable words LEAD the line and NAME the prompt (matching
    // the tab bar's phase display name); the accessible name carries the full
    // sentence.
    const copyButton = within(line).getByRole('button', {
      name: /^Copy the Specify prompt/,
    });
    expect(copyButton.textContent).toBe('Copy the Specify prompt');
  });

  it('build: "Copy the Build prompt into your coding agent to complete the Tasks and build this spec."', async () => {
    tagAc(AC(17));
    renderAt('build');

    await screen.findByTestId('task-panel');
    const line = screen.getByTestId('phase-handoff-line');
    expect(line.textContent).toContain(
      'Copy the Build prompt into your coding agent to complete the Tasks and build this spec.',
    );
  });

  it('verify: "Copy the Verify prompt into your coding agent to verify this spec against its ACs."', async () => {
    tagAc(AC(17));
    renderAt('verify');

    await screen.findByTestId('ac-panel');
    const line = screen.getByTestId('phase-handoff-line');
    expect(line.textContent).toContain(
      'Copy the Verify prompt into your coding agent to verify this spec against its ACs.',
    );
  });

  it('done: no handoff line at all', async () => {
    tagAc(AC(17));
    renderAt('done');

    await screen.findByTestId('done-summary');
    expect(screen.queryByTestId('phase-handoff-line')).not.toBeInTheDocument();
  });

  it('a writable reviewer at Specify gets the review handoff ONLY — no phase handoff (spec-182 issue-2)', async () => {
    tagAc(AC182(17));
    tagAc(AC182(11));
    mockRole = 'reviewer';
    renderAt('specify');

    // spec-182 issue-2: the phase handoff is canEdit-gated — the reviewer
    // keeps dec-3's review handoff at Specify and nothing else.
    const line = await screen.findByTestId('review-handoff-line');
    expect(line.textContent).toContain(
      'Copy the review prompt into your coding agent if you prefer to conduct the review from there.',
    );
    expect(screen.queryByTestId('phase-handoff-line')).not.toBeInTheDocument();
  });
});

// spec-164 dec-5 — reopening a done Spec from the summary report.
describe('done → verify reopen wiring (spec-164)', () => {
  const AC164 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-164/acs/ac-${n}`;

  it('threads canReopen to the DoneSummary and onReopen writes status verify', async () => {
    tagAc(AC164(22));
    tagAc(AC164(23));
    tagAc('mindset-prod/memex-building-itself/specs/spec-164/acs/ac-6');
    renderAt('done');

    const summary = await screen.findByTestId('done-summary');
    expect(summary).toHaveAttribute('data-can-reopen', 'true');

    await userEvent.click(screen.getByTestId('stub-reopen'));
    await waitFor(() => expect(updateDocStatus).toHaveBeenCalledWith('doc-uuid', 'verify'));
  });
});

// spec-164 issue-1 — draft no longer shows the create-Decisions-and-ACs
// handoff line. dec-3 gates the Decisions & ACs panels in draft behind an
// empty-state directive that invites the move to Specify first; handing the
// user a coding-agent prompt to "create Decisions and ACs" while in draft
// contradicts that gate-the-invitation principle. The handoff is split so
// draft yields null, while specify onward keeps it per-phase. These
// gating ACs are the draft-empty-state ones (ac-17 shared the original handoff;
// ac-5 owns the Decisions & ACs panel gating).
describe('spec-164 issue-1 — draft hides the create-Decisions-and-ACs handoff', () => {
  const AC164 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-164/acs/ac-${n}`;

  it('draft: no phase-handoff-line, but the transition sentence still renders', async () => {
    tagAc(AC164(17));
    tagAc(AC164(5));
    renderAt('draft');

    // The Rubicon transition sentence (the move-to-Specify invitation) is still
    // present — only the coding-agent handoff is gated out.
    expect(await screen.findByTestId('transition-sentence')).toBeInTheDocument();
    expect(screen.queryByTestId('phase-handoff-line')).not.toBeInTheDocument();
  });

  it('specify: the create-Decisions-and-ACs handoff returns once out of draft', async () => {
    tagAc(AC164(17));
    tagAc(AC164(5));
    renderAt('specify');

    const line = await screen.findByTestId('phase-handoff-line');
    expect(line.textContent).toContain(
      'Copy the Specify prompt into your coding agent to create Decisions and ACs.',
    );
  });
});
