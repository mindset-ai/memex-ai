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
import { render, screen, waitFor, within, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import type { ReactNode } from 'react';
import type { DocWithGraph } from '../api/types';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-159/acs/ac-${n}`;
const AC252 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-252/acs/ac-${n}`;
// spec-283 relocates the review actions off the page; these tests verify the
// page-side removal (ac-3/ac-9) — the agent-side arrival is in ChatPanel.test.tsx.
const AC283 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-283/acs/ac-${n}`;
// spec-287: one prompt per posture in Specify — the review handoff is re-gated
// to non-editors (!canEdit), and its link is Title Case ("Copy the Review
// prompt"). Supersedes spec-283 dec-4's "ungated, both postures" clause.
const AC287 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-287/acs/ac-${n}`;

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
// spec-287: a read-only (non-member) viewer has canWrite=false → canEdit=false,
// so they fall on the non-editor side of the review-handoff gate. Mutable so a
// test can drop write access without re-mocking the module.
let mockCanWrite = true;
const refetchRole = vi.fn();
vi.mock('../hooks/useMemexAccess', () => ({
  useMemexAccess: () => ({ canWrite: mockCanWrite, isReadOnly: !mockCanWrite }),
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
  mockCanWrite = true;
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

  // spec-282 (dec-1/dec-2/dec-3) supersedes the spec-159/spec-260 per-phase
  // layouts: ONE persistent sub-tab control carries the full inventory in every
  // phase. Build LANDS on Decisions & ACs (dec-3); the Agent Tasks & Issues tab
  // reveals the work view. (The old "Build/Verify carry no sub-tab bar" ac-11 is
  // superseded; the QA-report tab is covered in DocDocument.spec-260.test.tsx.)
  it('Build lands on Decisions & ACs; the full sub-tab inventory is present (ac-5)', async () => {
    tagAc(AC(5));
    const user = userEvent.setup();
    renderAt('build');

    // The unified control carries the full inventory.
    await screen.findByText('Narrative');
    expect(screen.getByText('Comments')).toBeInTheDocument();
    expect(screen.getByText('Decisions & ACs')).toBeInTheDocument();
    expect(screen.getByText('Agent Tasks & Issues')).toBeInTheDocument();
    expect(screen.getByText('QA Report')).toBeInTheDocument();

    // Build's default landing is Decisions & ACs (decision + AC panels).
    expect(screen.getByTestId('decision-panel')).toBeInTheDocument();
    expect(screen.getByTestId('ac-panel')).toBeInTheDocument();

    // The work view is one click away.
    await user.click(screen.getByText('Agent Tasks & Issues'));
    expect(screen.getByTestId('task-panel')).toBeInTheDocument();
    expect(screen.getByTestId('issue-panel')).toBeInTheDocument();

    // The phase bar is still the only role=tab tablist (4 phase tabs).
    expect(screen.getAllByRole('tab')).toHaveLength(4);
  });

  it('Verify lands on Decisions & ACs when no report exists; the work tab stays reachable (ac-5)', async () => {
    tagAc(AC(5));
    const user = userEvent.setup();
    renderAt('verify');

    // No QA report seeded → verify falls back to Decisions & ACs (dec-3).
    await screen.findByTestId('ac-panel');
    expect(screen.getByText('QA Report')).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(4);

    // Agent Tasks & Issues remains reachable in verify (accretion never removes it).
    await user.click(screen.getByText('Agent Tasks & Issues'));
    expect(screen.getByTestId('task-panel')).toBeInTheDocument();
    expect(screen.getByTestId('issue-panel')).toBeInTheDocument();
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

    await screen.findByTestId('decision-panel'); // build lands on Decisions & ACs
    // build is the current phase.
    expect(phaseTab('build')).toHaveAttribute('data-current', 'true');

    // Browse the Verify view.
    await user.click(phaseTab('verify'));

    // The current-phase highlight is STILL on build; verify is only selected,
    // and no status mutation fired.
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
    // verify → done is a forward step; with every active AC verified the browse-
    // forward confirm offers Yes (an AC-less verify is blocked).
    docAcs = [{ ac: { status: 'active' }, verificationState: 'verified' }];
    renderAt('verify');
    await screen.findByTestId('ac-panel');

    // spec-282/dec-4: the advance [Yes] lives on the browse-forward confirm, not
    // the current tab. Browse the Done tab; verify is clean → "Are you sure…?".
    await user.click(phaseTab('done'));
    const sentence = screen.getByTestId('transition-sentence');
    await waitFor(() =>
      expect(sentence).toHaveTextContent(/Are you sure you want to move this spec to Done\?/),
    );
    const yes = within(sentence).getByRole('button', { name: 'Yes' });
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
  it('specify with open decisions: the current-tab line is status-only; directive sits above Decisions (ac-3, ac-13)', async () => {
    tagAc(AC(3));
    tagAc(AC(13));
    const user = userEvent.setup();
    docDecisions = [decision('d-1', 'open'), decision('d-2', 'open')];
    docAcs = [{ ac: { status: 'active' }, verificationState: 'untested' }];
    renderAt('specify');

    // spec-282/dec-4: the current tab states the exact rubric condition but is
    // STATUS-ONLY — no override, no button. (waitFor: the AC fetch resolving
    // flips `hasAcceptanceCriteria` async.)
    const sentence = await screen.findByTestId('transition-sentence');
    await waitFor(() =>
      expect(sentence.textContent).toContain(
        '2 Decisions must be resolved before this spec can move to Build.',
      ),
    );
    expect(sentence.textContent).not.toContain('anyway?');
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

  it('build with open tasks: directive above the work view; current-tab line is status-only (ac-13)', async () => {
    tagAc(AC(13));
    const user = userEvent.setup();
    docTasks = [{ id: 't-1', status: 'in_progress' }, { id: 't-2', status: 'complete' }];
    renderAt('build');

    // The build directive renders on the Agent Tasks & Issues tab.
    await screen.findByTestId('decision-panel'); // build landing
    await user.click(screen.getByText('Agent Tasks & Issues'));
    await screen.findByTestId('task-panel');
    const text = screen
      .getAllByTestId('phase-directive')
      .map((d) => d.textContent)
      .join(' ');
    expect(text).toContain(
      '1 Task must be completed (or kicked to Issues) before this spec can move to Verify.',
    );
    // spec-282/dec-4: the current-tab line states the condition but is status-only
    // — no override, no button.
    const sentence = screen.getByTestId('transition-sentence');
    expect(sentence.textContent).toContain(
      '1 Task must be completed before this spec can move to Verify.',
    );
    expect(sentence.textContent).not.toContain('anyway?');
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

  it("directives are keyed to the spec's actual phase, not the browsed tab — the build directive stays silent in specify (ac-13)", async () => {
    tagAc(AC(13));
    const user = userEvent.setup();
    // Current phase specify (with open decisions + tasks); the Agent Tasks &
    // Issues tab must NOT show the build→verify directive (its gate is the build
    // phase, not the browsed sub-tab).
    docDecisions = [decision('d-1', 'open')];
    docTasks = [{ id: 't-1', status: 'in_progress' }];
    renderAt('specify');
    await screen.findByText('Narrative');

    await user.click(screen.getByText('Agent Tasks & Issues'));
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
    await screen.findByTestId('decision-panel'); // build lands on Decisions & ACs

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
    tagAc(AC287(1));
    mockRole = 'editor';
    renderAt('specify');
    await screen.findByText('Narrative');

    // Editors still get the PhaseTabBar (3 phase tabs) and the Rubicon line.
    expect(screen.getAllByRole('tab')).toHaveLength(4);
    expect(screen.getByTestId('transition-sentence')).toBeInTheDocument();
    // spec-283 dec-4: the "Review actions" disclosure + button row are GONE
    // from the page (relocated to the agent's idle state). spec-287 dec-2: the
    // review-handoff line is now NON-editor-only — an editor sees neither the
    // toggle, the row, NOR the review handoff. One prompt per posture: the
    // editor's single Specify-phase prompt is the phase handoff below.
    expect(screen.queryByTestId('review-actions-toggle')).not.toBeInTheDocument();
    expect(screen.queryByTestId('review-action-row')).not.toBeInTheDocument();
    expect(screen.queryByTestId('review-handoff-line')).not.toBeInTheDocument();
  });

  // spec-283 dec-4 — the "Review actions" disclosure (spec-182 ac-10/ac-11) is
  // RETIRED: the toggle and the four-button row are deleted from the page (the
  // actions moved to the agent's idle state). spec-287 dec-2 then SUPERSEDES
  // spec-283's "review handoff ungated for both postures": one prompt per
  // posture. For the editor that single prompt is the phase handoff — the
  // review handoff is NOT shown. (The toggle/row-gone half of spec-283 ac-9
  // still holds and is still tagged here.)
  it('editor at Specify: no review disclosure/row, and the review-handoff line is NOT shown — only the phase handoff (spec-287 ac-1/ac-8, supersedes spec-283 dec-4 for editors)', async () => {
    tagAc(AC283(9));
    tagAc(AC287(1));
    tagAc(AC287(8));
    tagAc(AC287(9)); // the editor's phase handoff still renders (canEdit && handoff)
    mockRole = 'editor';
    renderAt('specify');

    await screen.findByText('Narrative');
    expect(screen.queryByTestId('review-actions-toggle')).not.toBeInTheDocument();
    expect(screen.queryByTestId('review-action-row')).not.toBeInTheDocument();
    // spec-287: the review handoff is non-editor-only — absent for the editor.
    expect(screen.queryByTestId('review-handoff-line')).not.toBeInTheDocument();
    // The editor's single Specify-phase prompt: the phase handoff.
    expect(screen.getByTestId('phase-handoff-line')).toBeInTheDocument();
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

    // spec-283: the review-action row is gone; the review-handoff line is the
    // stable Specify-phase reviewer affordance to anchor on.
    await screen.findByTestId('review-handoff-line');
    // The PhaseTabBar renders for reviewers too (dec-1) — browse-only.
    expect(screen.getAllByRole('tab')).toHaveLength(4);
    // The Rubicon line renders status-only: present, but no [Yes] (dec-2).
    const sentence = screen.getByTestId('transition-sentence');
    expect(within(sentence).queryByRole('button', { name: 'Yes' })).not.toBeInTheDocument();
    // spec-283 dec-4: the "Review actions" disclosure toggle is deleted.
    expect(screen.queryByTestId('review-actions-toggle')).not.toBeInTheDocument();
  });

  it('posture pill reads "You are reviewing"; picking Editing promotes to editor', async () => {
    tagAc(AC(19));
    tagAc(AC252(9)); // spec-252 dec-2: pill relocated into the phase container
    tagAc(AC252(10)); // spec-252: this header-slot assertion updated to the new location
    const user = userEvent.setup();
    renderAt('specify');
    await screen.findByTestId('review-handoff-line');

    // spec-252 dec-2: the pill moved OUT of the header slot INTO the in-page
    // phase container, left of the phase bar. It is no longer in the header
    // slot, and sits inside data-testid="phase-container".
    const header = screen.getByTestId('header-slot');
    const container = screen.getByTestId('phase-container');
    const pill = await within(container).findByRole('button', { name: /You are reviewing/ });
    expect(within(header).queryByRole('button', { name: /You are reviewing/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/You are a reviewer of this spec/)).not.toBeInTheDocument();

    await user.click(pill);
    await user.click(screen.getByRole('menuitemradio', { name: /Editing/ }));
    // useSwitchPosture → promoteToEditor(docId) then a role refetch.
    await waitFor(() => expect(promoteToEditor).toHaveBeenCalledWith('doc-uuid'));
    expect(demoteToReviewer).not.toHaveBeenCalled();
    expect(refetchRole).toHaveBeenCalled();
  });

  it('editor: posture pill reads "You are editing"; picking Reviewing demotes to reviewer', async () => {
    tagAc(AC(19));
    tagAc(AC252(10)); // spec-252: header-slot assertion updated to the in-container location
    mockRole = 'editor';
    const user = userEvent.setup();
    renderAt('specify');
    await screen.findByText('Narrative');

    // spec-252 dec-2: the pill is in the in-page phase container, not the header.
    const container = screen.getByTestId('phase-container');
    await user.click(await within(container).findByRole('button', { name: /You are editing/ }));
    await user.click(screen.getByRole('menuitemradio', { name: /Reviewing/ }));
    // useSwitchPosture → demoteToReviewer(docId) then a role refetch.
    await waitFor(() => expect(demoteToReviewer).toHaveBeenCalledWith('doc-uuid'));
    expect(promoteToEditor).not.toHaveBeenCalled();
    expect(refetchRole).toHaveBeenCalled();
  });

  // spec-283 ac-3 (retires spec-182 ac-3): the four review buttons are gone
  // from the page — their behaviour ("clicking one sends the scaffold prompt
  // through chat") is re-verified on the AGENT surface in ChatPanel.test.tsx.
  it('reviewer at Specify: no review buttons remain on the page; only the review-handoff line (spec-283 ac-3)', async () => {
    tagAc(AC283(3));
    renderAt('specify');

    await screen.findByTestId('review-handoff-line');
    expect(screen.queryByTestId('review-action-row')).not.toBeInTheDocument();
    for (const label of ['Summarise Spec', 'Security review', 'Design review', 'Architecture review']) {
      expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
    }
  });

  it('renders the reviewer handoff line — "Copy the Review prompt …conduct the review from there." (spec-287 ac-2/ac-3/ac-7)', async () => {
    tagAc(AC182(11));
    tagAc(AC287(2));
    tagAc(AC287(3));
    tagAc(AC287(7));
    renderAt('specify');

    const line = await screen.findByTestId('review-handoff-line');
    // spec-287 dec-1: Title Case, matching the Specify/Build/Verify family.
    expect(line.textContent).toContain(
      'Copy the Review prompt into your coding agent if you prefer to conduct the review from there.',
    );
    // issue-4: the clickable words LEAD the line and NAME the prompt, so
    // adjacent handoff lines are distinguishable from the link text alone.
    const copyButton = within(line).getByRole('button', {
      name: /^Copy the Review prompt/,
    });
    expect(copyButton.textContent).toBe('Copy the Review prompt');
    // spec-182 issue-2 + spec-287 dec-2: a reviewer gets the review handoff
    // ONLY — one prompt per posture, so the editor's phase handoff is absent.
    expect(screen.queryByTestId('phase-handoff-line')).not.toBeInTheDocument();
  });

  it('a reviewer at Build sees NO coding-agent handoff line (issue-2)', async () => {
    tagAc(AC182(17));
    renderAt('build');

    await screen.findByTestId('decision-panel'); // build lands on Decisions & ACs
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
    const user = userEvent.setup();
    renderAt('build');

    await screen.findByTestId('decision-panel'); // build lands on Decisions & ACs
    await user.click(screen.getByText('Agent Tasks & Issues'));
    expect(screen.getByTestId('task-panel')).toBeInTheDocument();
    expect(screen.getByTestId('issue-panel')).toBeInTheDocument();
    // dec-1: the tab bar renders for reviewers; dec-3: no review row off-Specify.
    expect(screen.getAllByRole('tab')).toHaveLength(4);
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

    await screen.findByTestId('decision-panel'); // build lands on Decisions & ACs
    // Click the Verify tab — the verify view renders, the phase is untouched.
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

    await screen.findByTestId('decision-panel'); // build lands on Decisions & ACs
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

  it('a writable reviewer at Specify gets the review handoff ONLY — no phase handoff (spec-182 issue-2, spec-287 ac-2)', async () => {
    tagAc(AC182(17));
    tagAc(AC182(11));
    tagAc(AC287(2));
    tagAc(AC287(9)); // reviewer sees review-handoff, NOT phase-handoff
    mockRole = 'reviewer';
    renderAt('specify');

    // spec-182 issue-2 + spec-287 dec-2: the phase handoff is canEdit-gated —
    // the reviewer keeps the review handoff at Specify and nothing else.
    const line = await screen.findByTestId('review-handoff-line');
    expect(line.textContent).toContain(
      'Copy the Review prompt into your coding agent if you prefer to conduct the review from there.',
    );
    expect(screen.queryByTestId('phase-handoff-line')).not.toBeInTheDocument();
  });

  // spec-287 ac-2: a READ-ONLY viewer (non-member: canWrite=false → canEdit=
  // false) falls on the non-editor side of the gate — they see the review
  // handoff and NOT the editor's phase handoff, same as a reviewer.
  it('a read-only viewer at Specify sees the review handoff ONLY — no phase handoff (spec-287 ac-2/ac-9)', async () => {
    tagAc(AC287(2));
    tagAc(AC287(9));
    mockCanWrite = false;
    mockRole = 'reviewer';
    renderAt('specify');

    const line = await screen.findByTestId('review-handoff-line');
    expect(line.textContent).toContain('Copy the Review prompt');
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

// ───────────────────────────────────────────────────────────────────────────
// spec-252 — coloured phase container + relocated posture pill. Reuses this
// file's DocDocument harness (renderAt / HeaderSink).
// ───────────────────────────────────────────────────────────────────────────
describe('spec-252 — coloured phase container', () => {
  // Reviewer posture: canWrite (pill shows) but !canEdit, so the review-action
  // row + handoff render expanded (no collapse toggle) — the ac-11 wrap check
  // needs them visible. The global beforeEach otherwise defaults to editor.
  beforeEach(() => {
    mockRole = 'reviewer';
  });

  it('wraps the phase block in a container carrying the current phase colour, per phase (ac-1, ac-2, ac-4)', async () => {
    tagAc(AC252(1));
    tagAc(AC252(2));
    tagAc(AC252(4)); // theme-aware token class → both modes; contrast proven by ac-8
    const cases = [
      ['draft', 'bg-phase-draft-container'],
      ['specify', 'bg-phase-specify-container'],
      ['build', 'bg-phase-build-container'],
      ['verify', 'bg-phase-verify-container'],
    ] as const;
    for (const [status, cls] of cases) {
      renderAt(status);
      const container = await screen.findByTestId('phase-container');
      // ac-1: the phase bar lives inside the container.
      expect(
        within(container).getByRole('tablist', { name: /Spec phase view/i }),
      ).toBeInTheDocument();
      // ac-2 / ac-4: the bg is this phase's theme-aware token.
      expect(container.className, `${status} container colour`).toContain(cls);
      cleanup();
    }
  });

  it('renders NO phase container at done — the done treatment is unchanged (ac-2)', async () => {
    tagAc(AC252(2));
    renderAt('done');
    await screen.findByTestId('done-summary');
    expect(screen.queryByTestId('phase-container')).not.toBeInTheDocument();
  });

  it('wraps exactly the phase block (pill, bar, transition, review handoff) and excludes the title + content Tabs (ac-11)', async () => {
    tagAc(AC252(11));
    renderAt('specify'); // default role = reviewer (canWrite, !canEdit)
    const container = await screen.findByTestId('phase-container');
    await within(container).findByTestId('review-handoff-line');

    // INSIDE the container.
    expect(within(container).getByRole('button', { name: /You are reviewing/ })).toBeInTheDocument();
    expect(within(container).getByRole('tablist', { name: /Spec phase view/i })).toBeInTheDocument();
    expect(within(container).getByTestId('transition-sentence')).toBeInTheDocument();
    // spec-283 dec-4: the review-action row left the page; the review-handoff
    // line remains inside the phase container.
    expect(within(container).queryByTestId('review-action-row')).not.toBeInTheDocument();
    expect(within(container).getByTestId('review-handoff-line')).toBeInTheDocument();

    // OUTSIDE: the doc title (no heading inside) and the content Tabs row.
    expect(within(container).queryByRole('heading')).not.toBeInTheDocument();
    expect(within(container).queryByText('Decisions & ACs')).not.toBeInTheDocument();
  });

  it('places the posture pill LEFT of the phase bar, as the only posture switch (ac-3, ac-9, ac-11)', async () => {
    tagAc(AC252(3)); // scope: edit/review dropdown sits inside the container, left of the phase bar
    tagAc(AC252(9));
    tagAc(AC252(11));
    renderAt('specify');
    const container = await screen.findByTestId('phase-container');
    const pill = await within(container).findByRole('button', { name: /You are reviewing/ });
    const tablist = within(container).getByRole('tablist', { name: /Spec phase view/i });
    // Exactly one posture switch on the page (spec-182/dec-6 preserved).
    expect(screen.getAllByRole('button', { name: /You are (reviewing|editing)/ })).toHaveLength(1);
    // DOM order: the pill precedes (sits left of) the phase bar on the shared row.
    expect(
      pill.compareDocumentPosition(tablist) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('introduces no new functionality — phase indicator and the review-handoff CTA are intact (ac-5)', async () => {
    tagAc(AC252(5));
    renderAt('specify'); // reviewer: the review-handoff line renders
    await screen.findByTestId('review-handoff-line');

    // Phase progress indicator — unchanged: the four-tab pipeline, specify
    // current with its ● dot, browse-only behaviour preserved.
    expect(screen.getAllByRole('tab')).toHaveLength(4);
    expect(phaseTab('specify')).toHaveAttribute('data-current', 'true');
    expect(phaseTab('specify').textContent).toContain('●');

    // spec-283 dec-4: the four review BUTTONS moved to the agent's idle state —
    // they no longer render on the page. Their click-sends-a-prompt behaviour is
    // re-verified on the agent surface (ChatPanel.test.tsx). The review-handoff
    // "copy prompt" CTA stays on the page.
    expect(screen.queryByTestId('review-action-row')).not.toBeInTheDocument();
    expect(screen.getByTestId('review-handoff-line')).toBeInTheDocument();
  });
});
