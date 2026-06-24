// spec-343 page-level tests — the redesigned lifecycle-timeline surface.
//
//   - ac-1:  timeline spine with gates as connectors; selection opens detail.
//   - ac-7:  edit affordances admin-only; non-admin/personal read-only.
//   - ac-9:  org-global in the Always-applies band; actions shelf; handoff on phase.
//   - ac-10: circumstance detail = inline base-vs-org segments; no Live preview pane.
//   - ac-11: Add-here derives target from position; on save it composes inline.
//   - ac-12: reach groups + badges; Add-here only on shared content.
//   - ac-13: landing is the timeline map (not the explainer essay); rationale on demand.
//   - ac-14: non-admin sees the "admin required" note; admins do not.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import type {
  GuidanceBlock,
  PhaseNode,
  PromptBlockNode,
  PromptButtonNode,
  ScaffoldDataset,
  ToolNode,
  TransitionRubric,
} from '@memex/shared';

const ac = (n: number) => `mindset-prod/memex-building-itself/specs/spec-343/acs/ac-${n}`;

const promptBlocks: PromptBlockNode[] = [
  { kind: 'prompt_block', id: 'role', surface: 'react_only', text: 'You are an agent.', rationale: 'Role rationale.' },
  { kind: 'prompt_block', id: 'mut', surface: 'shared_nudge', text: 'Confirm before mutating.', rationale: 'Mutation rationale.' },
];

function phase(p: PhaseNode['phase'], blocked: string[] = []): PhaseNode {
  return {
    kind: 'phase',
    phase: p,
    intent: `${p} intent`,
    allowance: { allowed: [], blocked },
    promptBlockIds: ['role'],
    rationale: `${p} rationale.`,
  };
}

const phases: PhaseNode[] = [phase('draft'), phase('specify'), phase('build'), phase('verify'), phase('done')];

const tools: ToolNode[] = [
  { kind: 'tool', name: 'update_section', summary: 'Edit a section.', args: '(id, content)', group: 'planning', rationale: 'update_section rationale.' },
  { kind: 'tool', name: 'create_task', summary: 'Create a build task.', args: '(ref, title)', group: 'build', rationale: 'create_task rationale.' },
];

const transitions: TransitionRubric[] = [
  { kind: 'transition_rubric', transition: 'specify', text: 'PLAN GATE PROSE.', rationale: 'Plan rubric rationale.' },
  { kind: 'transition_rubric', transition: 'build', text: 'BUILD GATE PROSE.', rationale: 'Build rubric rationale.' },
  { kind: 'transition_rubric', transition: 'verify', text: 'VERIFY GATE PROSE.', rationale: 'Verify rubric rationale.' },
  { kind: 'transition_rubric', transition: 'done', text: 'DONE GATE PROSE.', rationale: 'Done rubric rationale.' },
];

const baseGuidance: GuidanceBlock[] = [
  { kind: 'guidance_block', source: 'base', target: {}, text: 'BASE GLOBAL BLOCK.', enabled: true, order: 0, rationale: 'Base global rationale.' },
  { kind: 'guidance_block', source: 'base', target: { phase: 'build' }, text: 'BASE BUILD STAGE.', enabled: true, order: 1, rationale: 'Base build rationale.' },
  { kind: 'guidance_block', source: 'base', target: { tool: 'create_task', phase: 'build' }, text: 'BASE CREATE_TASK NUDGE.', enabled: true, order: 2, rationale: 'Base nudge rationale.' },
];

// id 'opening-build-handoff' is the real build handoff (HANDOFF_BUTTON_BY_PHASE);
// 'add-comment' is a cross-phase action button → the Actions shelf.
const promptButtons: PromptButtonNode[] = [
  { kind: 'prompt_button', id: 'opening-build-handoff', label: 'Start building', text: 'BUILD HANDOFF TEXT.', surfaces: ['spec'], rationale: 'Handoff rationale.' },
  { kind: 'prompt_button', id: 'add-comment', label: 'Add a comment', text: 'ADD COMMENT TEXT.', surfaces: ['spec'], rationale: 'Comment rationale.' },
];

const dataset: ScaffoldDataset = { phases, promptBlocks, tools, transitions, baseGuidance, promptButtons };

const orgGlobal: GuidanceBlock & { id: string } = {
  kind: 'guidance_block', source: 'org', target: {}, text: 'ORG GLOBAL ADDITION.', enabled: true, order: 0,
  rationale: 'Org global rationale.', id: 'org-g', orgId: 'org-uuid', authorId: 'user-1', updatedAt: '2026-06-01T00:00:00Z',
};
const orgBuildStage: GuidanceBlock & { id: string } = {
  kind: 'guidance_block', source: 'org', target: { phase: 'build' }, text: 'ORG BUILD STAGE.', enabled: true, order: 0,
  rationale: 'Org build rationale.', id: 'org-b', orgId: 'org-uuid', authorId: 'user-1', updatedAt: '2026-06-02T00:00:00Z',
};

const fetchScaffoldMock = vi.hoisted(() => vi.fn());
const createScaffoldAdditionMock = vi.hoisted(() => vi.fn());
const toggleScaffoldAdditionMock = vi.hoisted(() => vi.fn());
const updateScaffoldAdditionMock = vi.hoisted(() => vi.fn());
const deleteScaffoldAdditionMock = vi.hoisted(() => vi.fn());
const getOrgApiMock = vi.hoisted(() => vi.fn());

vi.mock('../api/scaffold', () => ({
  // spec-360 follow-up: the page now calls the owner-aware *For variants.
  fetchScaffoldFor: (...a: unknown[]) => fetchScaffoldMock(...a),
  createScaffoldAdditionFor: (...a: unknown[]) => createScaffoldAdditionMock(...a),
  toggleScaffoldAdditionFor: (...a: unknown[]) => toggleScaffoldAdditionMock(...a),
  updateScaffoldAdditionFor: (...a: unknown[]) => updateScaffoldAdditionMock(...a),
  deleteScaffoldAdditionFor: (...a: unknown[]) => deleteScaffoldAdditionMock(...a),
}));
vi.mock('../api/client', async () => ({ getOrgApi: (...a: unknown[]) => getOrgApiMock(...a) }));
const useAuthMock = vi.hoisted(() => vi.fn());
vi.mock('../components/AuthContext', () => ({ useAuth: () => useAuthMock() }));

// spec-360: ScaffoldInspect now mounts the scaffold assistant (ChatPanel in
// scaffold mode) and reads the chat context. Stub both so the page renders
// without a real ChatProvider; the assistant's own behaviour is covered by its
// own tests (graph.scaffold, ScaffoldProposalReview, scaffold-assistant.integration).
const enterScaffoldModeMock = vi.hoisted(() => vi.fn());
const exitScaffoldModeMock = vi.hoisted(() => vi.fn());
const clearScaffoldProposalMock = vi.hoisted(() => vi.fn());
const startScaffoldOpeningTurnMock = vi.hoisted(() => vi.fn());
// spec-360 issue-10: the page now destructures sendMessage from useChat — it
// fires the review seed after a MANUAL add/edit. The mock must provide it.
const sendMessageMock = vi.hoisted(() => vi.fn());
const useChatMock = vi.hoisted(() => vi.fn());
vi.mock('../components/ChatPanel', () => ({
  ChatPanel: () => <div data-testid="chat-panel-stub">assistant</div>,
}));
vi.mock('../components/ChatContext', () => ({ useChat: () => useChatMock() }));

import { ScaffoldInspect } from './ScaffoldInspect';

function setupAuth(role: 'member' | 'administrator') {
  useAuthMock.mockReturnValue({
    token: 'fake',
    session: {
      user: { id: 'u-1' },
      currentMemexId: 'mx-1',
      memberships: [{ memexId: 'mx-1', slug: 'acme', memexSlug: 'main', name: 'Acme', memexName: 'Main', kind: 'team', role }],
    },
  });
}

// spec-360 follow-up: a PERSONAL namespace membership. The path /alice/personal
// resolves to this row; the owner is the admin of their own workspace, so
// authoring is theirs by right (no org, no org lookup).
function setupPersonalAuth() {
  useAuthMock.mockReturnValue({
    token: 'fake',
    session: {
      user: { id: 'u-1' },
      currentMemexId: 'mx-1',
      memberships: [
        { memexId: 'mx-1', slug: 'alice', memexSlug: 'personal', name: 'Alice', memexName: 'Personal', kind: 'personal', role: 'member' },
      ],
    },
  });
}

function renderPage(path = '/acme/main/scaffold') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ScaffoldInspect />
    </MemoryRouter>,
  );
}

async function openBuildPhase(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByTestId('scaffold-timeline-phase-build'));
}

function setupChat(
  proposal: unknown = null,
  extra: { isScaffoldMode?: boolean; scaffoldNav?: unknown } = {},
) {
  useChatMock.mockReturnValue({
    enterScaffoldMode: enterScaffoldModeMock,
    exitScaffoldMode: exitScaffoldModeMock,
    scaffoldProposal: proposal,
    clearScaffoldProposal: clearScaffoldProposalMock,
    startScaffoldOpeningTurn: startScaffoldOpeningTurnMock,
    sendMessage: sendMessageMock,
    isScaffoldMode: extra.isScaffoldMode ?? false,
    scaffoldNav: extra.scaffoldNav ?? null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getOrgApiMock.mockResolvedValue({ id: 'org-uuid', name: 'Acme', slug: 'acme' });
  fetchScaffoldMock.mockResolvedValue({ base: dataset, org: [orgGlobal, orgBuildStage] });
  setupChat();
});

describe('ScaffoldInspect — timeline IA (ac-1)', () => {
  it('renders the lifecycle spine with phases and gates as connectors', async () => {
    tagAc(ac(1));
    tagAc(ac(6));
    setupAuth('administrator');
    renderPage();
    const timeline = await screen.findByTestId('scaffold-timeline');
    for (const p of ['draft', 'specify', 'build', 'verify', 'done']) {
      expect(within(timeline).getByTestId(`scaffold-timeline-phase-${p}`)).toBeInTheDocument();
    }
    for (const g of ['specify', 'build', 'verify', 'done']) {
      expect(within(timeline).getByTestId(`scaffold-timeline-gate-${g}`)).toBeInTheDocument();
    }
  });

  it('selecting a phase opens its detail; selecting a gate opens the rubric circumstance', async () => {
    tagAc(ac(1));
    tagAc(ac(6));
    setupAuth('administrator');
    renderPage();
    const user = userEvent.setup();
    await openBuildPhase(user);
    expect(screen.getByTestId('scaffold-phase-detail-build')).toBeInTheDocument();
    await user.click(screen.getByTestId('scaffold-timeline-gate-build'));
    const gate = screen.getByTestId('scaffold-circumstance-gate');
    expect(gate).toHaveTextContent('BUILD GATE PROSE.');
    expect(screen.getByTestId('scaffold-gate-fact-sheet')).toBeInTheDocument();
  });
});

describe('ScaffoldInspect — landing is the timeline map (ac-13)', () => {
  it('default view leads with the timeline map; the explainer lives in the empty state below', async () => {
    tagAc(ac(13));
    tagAc(ac(4)); // scope: the map leads; the explainer fills the otherwise-blank home pane

    setupAuth('administrator');
    renderPage();
    // The timeline map still leads the surface (top frame).
    expect(await screen.findByTestId('scaffold-timeline')).toBeInTheDocument();
    // spec-360: the "how it works" explainer is the home/empty-state content now
    // (moved out of the old collapsible top strip), shown in the detail pane.
    expect(screen.getByTestId('scaffold-home-hint')).toBeInTheDocument();
    expect(screen.getByTestId('scaffold-explainer')).toBeInTheDocument();
  });

  it('selecting a moment replaces the empty-state explainer with that circumstance', async () => {
    tagAc(ac(13));
    setupAuth('administrator');
    renderPage();
    const user = userEvent.setup();
    // On a real selection the home explainer gives way to the circumstance detail.
    await openBuildPhase(user);
    expect(screen.queryByTestId('scaffold-explainer')).not.toBeInTheDocument();
    expect(screen.queryByTestId('scaffold-home-hint')).not.toBeInTheDocument();
  });

  it('base-element rationale is hidden until requested (ⓘ why)', async () => {
    tagAc(ac(13));
    setupAuth('administrator');
    renderPage();
    const user = userEvent.setup();
    await openBuildPhase(user);
    // The React-only block carries a rationale, surfaced only on demand.
    expect(screen.queryByTestId('scaffold-why-text')).not.toBeInTheDocument();
    const reactGroup = screen.getByTestId('scaffold-reach-group-react-only');
    await user.click(within(reactGroup).getAllByTestId('scaffold-why-toggle')[0]);
    expect(within(reactGroup).getByTestId('scaffold-why-text')).toHaveTextContent('Role rationale.');
  });
});

describe('ScaffoldInspect — composed segments, no Live preview (ac-10)', () => {
  it('a tool circumstance renders base and org segments inline, with no separate preview pane', async () => {
    tagAc(ac(10));
    tagAc(ac(2)); // scope: composed prompt shown base-vs-yours inline

    setupAuth('administrator');
    renderPage();
    const user = userEvent.setup();
    await openBuildPhase(user);
    await user.click(screen.getByTestId('scaffold-tool-create_task'));
    const detail = screen.getByTestId('scaffold-circumstance-nudge');
    const segments = within(detail).getAllByTestId('scaffold-segment');
    const sources = segments.map((s) => s.getAttribute('data-source'));
    expect(sources).toContain('base');
    // The old monolithic preview testids are gone.
    expect(screen.queryByTestId('scaffold-phase-live-preview-text')).not.toBeInTheDocument();
    expect(detail).toHaveTextContent('BASE CREATE_TASK NUDGE.');
  });

  it('an org segment carries inline toggle, edit, and delete controls (admin)', async () => {
    tagAc(ac(10));
    setupAuth('administrator');
    renderPage();
    const user = userEvent.setup();
    await openBuildPhase(user);
    // Stage circumstance includes the org build-stage block.
    const stage = screen.getByTestId('scaffold-circumstance-stage');
    expect(within(stage).getByTestId('scaffold-org-toggle-org-b')).toBeInTheDocument();
    expect(within(stage).getByTestId('scaffold-org-edit-org-b')).toBeInTheDocument();
    expect(within(stage).getByTestId('scaffold-org-delete-org-b')).toBeInTheDocument();
    await user.click(within(stage).getByTestId('scaffold-org-delete-org-b'));
    await waitFor(() =>
      expect(deleteScaffoldAdditionMock).toHaveBeenCalledWith(
        { kind: 'org', orgId: 'org-uuid' },
        'org-b',
      ),
    );
  });
});

describe('ScaffoldInspect — reach parity (ac-12)', () => {
  it('phase detail splits into both-agents and in-app-only groups; Add-here only on shared', async () => {
    tagAc(ac(12));
    setupAuth('administrator');
    renderPage();
    const user = userEvent.setup();
    await openBuildPhase(user);
    const bothGroup = screen.getByTestId('scaffold-reach-group-both');
    const reactGroup = screen.getByTestId('scaffold-reach-group-react-only');
    // Reach badges present.
    expect(within(reactGroup).getAllByTestId('scaffold-reach-badge')[0]).toHaveAttribute('data-reach', 'react_only');
    // Add-here exists in the shared group, never in the react-only group.
    expect(within(bothGroup).getAllByTestId('scaffold-add-here-trigger').length).toBeGreaterThan(0);
    expect(within(reactGroup).queryByTestId('scaffold-add-here-trigger')).not.toBeInTheDocument();
  });
});

describe('ScaffoldInspect — homes for buttons + org-global (ac-9)', () => {
  it('org-global rides the Always-applies band; cross-phase buttons live in the Actions shelf; handoff on the phase', async () => {
    tagAc(ac(9));
    setupAuth('administrator');
    renderPage();
    const user = userEvent.setup();
    // Band selects the global circumstance, which shows the org-global addition.
    await user.click(await screen.findByTestId('scaffold-always-applies-band'));
    expect(screen.getByTestId('scaffold-circumstance-global')).toHaveTextContent('ORG GLOBAL ADDITION.');
    // Actions shelf carries the cross-phase action button, not the handoff.
    const shelf = screen.getByTestId('scaffold-actions-shelf');
    expect(within(shelf).getByTestId('scaffold-action-button-add-comment')).toBeInTheDocument();
    expect(within(shelf).queryByTestId('scaffold-action-button-opening-build-handoff')).not.toBeInTheDocument();
    // The handoff button is attached to the build phase detail.
    await openBuildPhase(user);
    expect(screen.getByTestId('scaffold-phase-handoff-link')).toHaveTextContent('Start building');
  });
});

describe('ScaffoldInspect — in-context authoring (ac-11)', () => {
  it('Add-here derives the target from position and composes the new block inline on save', async () => {
    tagAc(ac(11));
    tagAc(ac(3)); // scope: in-context add with derived target composes live
    setupAuth('administrator');
    const newBlock: GuidanceBlock & { id: string } = {
      kind: 'guidance_block', source: 'org', target: { tool: 'create_task', phase: 'build' },
      text: 'NEW INLINE NUDGE.', enabled: true, order: 9, rationale: 'why', id: 'org-new', orgId: 'org-uuid',
    };
    fetchScaffoldMock.mockResolvedValueOnce({ base: dataset, org: [orgGlobal, orgBuildStage] });
    fetchScaffoldMock.mockResolvedValueOnce({ base: dataset, org: [orgGlobal, orgBuildStage, newBlock] });
    createScaffoldAdditionMock.mockResolvedValueOnce(newBlock);

    renderPage();
    const user = userEvent.setup();
    await openBuildPhase(user);
    await user.click(screen.getByTestId('scaffold-tool-create_task'));
    const detail = screen.getByTestId('scaffold-circumstance-nudge');

    await user.click(within(detail).getByTestId('scaffold-add-here-trigger'));
    // Target stated in plain language — no raw dimension dropdowns.
    expect(screen.getByTestId('scaffold-add-here-target-summary')).toHaveTextContent(
      'when create_task runs during build',
    );
    expect(screen.getByTestId('scaffold-add-here-broaden')).toBeInTheDocument();

    await user.type(screen.getByTestId('scaffold-add-here-text'), 'NEW INLINE NUDGE.');
    await user.type(screen.getByTestId('scaffold-add-here-rationale'), 'why');
    await user.click(screen.getByTestId('scaffold-add-here-submit'));

    await waitFor(() =>
      expect(createScaffoldAdditionMock).toHaveBeenCalledWith(
        { kind: 'org', orgId: 'org-uuid' },
        expect.objectContaining({ target: { tool: 'create_task', phase: 'build' }, text: 'NEW INLINE NUDGE.' }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId('scaffold-circumstance-nudge')).toHaveTextContent('NEW INLINE NUDGE.'),
    );
  });
});

describe('ScaffoldInspect — auth (ac-7, ac-14)', () => {
  it('admins see enabled Add-here affordances and no admin-required note', async () => {
    tagAc(ac(7));
    setupAuth('administrator');
    renderPage();
    const user = userEvent.setup();
    await openBuildPhase(user);
    const triggers = screen.getAllByTestId('scaffold-add-here-trigger');
    expect(triggers.length).toBeGreaterThan(0);
    expect(triggers[0]).not.toBeDisabled();
    expect(screen.queryByTestId('scaffold-admin-required-note')).not.toBeInTheDocument();
  });

  it('non-admin members see the Add-here buttons DISABLED plus a persistent admin-required note', async () => {
    tagAc(ac(14));
    setupAuth('member');
    renderPage();
    const user = userEvent.setup();
    expect(await screen.findByTestId('scaffold-admin-required-note')).toBeInTheDocument();
    await openBuildPhase(user);
    // The capability is visible (discoverable) but disabled — not hidden.
    const triggers = screen.getAllByTestId('scaffold-add-here-trigger');
    expect(triggers.length).toBeGreaterThan(0);
    triggers.forEach((t) => expect(t).toBeDisabled());
    // Controls on existing rows stay admin-only (hidden).
    expect(screen.queryByTestId('scaffold-org-toggle-org-b')).not.toBeInTheDocument();
  });

  // spec-360 follow-up: a personal namespace's OWNER is the admin of their own
  // workspace — so the page lets them author, exactly like an org admin, and
  // never resolves an org (no getOrgApi call). The api branches to the personal
  // (tenant-prefixed) endpoints.
  it('personal owner: can edit, targets the personal endpoints, no org lookup, no admin-required note', async () => {
    tagAc(ac(7));
    setupPersonalAuth();
    createScaffoldAdditionMock.mockResolvedValue({ id: 'p-new' });
    renderPage('/alice/personal/scaffold');
    const user = userEvent.setup();

    // Read goes through the PERSONAL owner ref (namespace + memex), never org.
    await waitFor(() =>
      expect(fetchScaffoldMock).toHaveBeenCalledWith({
        kind: 'personal',
        namespace: 'alice',
        memex: 'personal',
      }),
    );
    expect(getOrgApiMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('scaffold-admin-required-note')).not.toBeInTheDocument();

    // Authoring affordances are enabled for the owner.
    await openBuildPhase(user);
    const triggers = screen.getAllByTestId('scaffold-add-here-trigger');
    expect(triggers.length).toBeGreaterThan(0);
    triggers.forEach((t) => expect(t).not.toBeDisabled());
  });

  it('personal owner: the role badge reads Administrator', async () => {
    tagAc(ac(7));
    setupPersonalAuth();
    renderPage('/alice/personal/scaffold');
    // Home (empty) state hosts the explainer + the role badge.
    const badge = await screen.findByTestId('scaffold-role-badge');
    expect(badge).toHaveAttribute('data-role', 'admin');
    expect(badge).toHaveTextContent('Administrator');
  });

  it('personal owner: a write targets the personal owner ref', async () => {
    tagAc(ac(7));
    setupPersonalAuth();
    fetchScaffoldMock.mockResolvedValueOnce({ base: dataset, org: [orgGlobal, orgBuildStage] });
    fetchScaffoldMock.mockResolvedValue({ base: dataset, org: [orgGlobal, orgBuildStage] });
    createScaffoldAdditionMock.mockResolvedValue({ id: 'p-new' });
    renderPage('/alice/personal/scaffold');
    const user = userEvent.setup();
    await openBuildPhase(user);
    await user.click(screen.getByTestId('scaffold-tool-create_task'));
    await user.click(screen.getAllByTestId('scaffold-add-here-trigger')[0]);
    await user.type(screen.getByTestId('scaffold-add-here-text'), 'PERSONAL NUDGE.');
    await user.type(screen.getByTestId('scaffold-add-here-rationale'), 'mine');
    await user.click(screen.getByTestId('scaffold-add-here-submit'));
    await waitFor(() =>
      expect(createScaffoldAdditionMock).toHaveBeenCalledWith(
        { kind: 'personal', namespace: 'alice', memex: 'personal' },
        expect.objectContaining({ text: 'PERSONAL NUDGE.' }),
      ),
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────
// spec-360 — the scaffold assistant rides this surface.
// ──────────────────────────────────────────────────────────────────────────

describe('spec-360: the scaffold assistant panel (ac-1 / ac-11)', () => {
  const sc = (n: number) => `mindset-prod/memex-building-itself/specs/spec-360/acs/ac-${n}`;

  it('renders the assistant panel and enters scaffold mode on mount, for an admin', async () => {
    tagAc(sc(11));
    setupAuth('administrator');
    renderPage();
    expect(await screen.findByTestId('scaffold-assistant-panel')).toBeInTheDocument();
    expect(screen.getByTestId('chat-panel-stub')).toBeInTheDocument();
    expect(enterScaffoldModeMock).toHaveBeenCalled();
  });

  it('is available to a NON-admin viewer too — explanation is open to any member (ac-1)', async () => {
    tagAc(sc(1));
    tagAc(sc(11));
    setupAuth('member');
    renderPage();
    // The panel (explain) is present for a plain member…
    expect(await screen.findByTestId('scaffold-assistant-panel')).toBeInTheDocument();
    // …and the read-only "admin required" note still shows (authoring is gated).
    expect(await screen.findByTestId('scaffold-admin-required-note')).toBeInTheDocument();
  });

  it('leaves scaffold mode on unmount', async () => {
    tagAc(sc(11));
    setupAuth('administrator');
    const { unmount } = renderPage();
    await screen.findByTestId('scaffold-assistant-panel');
    unmount();
    expect(exitScaffoldModeMock).toHaveBeenCalled();
  });
});

describe('spec-360: a pending proposal renders composed on the surface (ac-9 / ac-2)', () => {
  const sc = (n: number) => `mindset-prod/memex-building-itself/specs/spec-360/acs/ac-${n}`;

  it('shows the proposal review and navigates the timeline to its target', async () => {
    tagAc(sc(9));
    setupAuth('administrator');
    setupChat({
      operation: 'add',
      target: { tool: 'create_task', phase: 'build' },
      text: 'Carry an AC on every build task.',
      rationale: 'house rule',
      summary: 'Add org guidance when create_task runs during build.',
    });
    renderPage();
    // The review card is composed in place…
    const review = await screen.findByTestId('scaffold-proposal-review');
    expect(review).toHaveAttribute('data-operation', 'add');
    expect(screen.getByTestId('scaffold-proposal-pending-segment')).toHaveTextContent(
      'Carry an AC on every build task.',
    );
    // …and the timeline navigated to the target circumstance (build phase detail).
    expect(await screen.findByTestId('scaffold-phase-detail-build')).toBeInTheDocument();
  });

  it('approving an add routes through the existing admin-gated create route (ac-2)', async () => {
    tagAc(sc(2));
    createScaffoldAdditionMock.mockResolvedValue({ id: 'new' });
    setupAuth('administrator');
    setupChat({
      operation: 'add',
      target: { phase: 'build' },
      text: 'Carry an AC on every build task.',
      rationale: 'house rule',
      summary: 'Add org guidance during build.',
    });
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('scaffold-proposal-approve'));
    await waitFor(() =>
      expect(createScaffoldAdditionMock).toHaveBeenCalledWith(
        { kind: 'org', orgId: 'org-uuid' },
        expect.objectContaining({ text: 'Carry an AC on every build task.' }),
      ),
    );
    expect(clearScaffoldProposalMock).toHaveBeenCalled();
  });

  it('rejecting clears the proposal and writes nothing (ac-2)', async () => {
    tagAc(sc(2));
    setupAuth('administrator');
    setupChat({
      operation: 'add',
      target: { phase: 'build' },
      text: 'x',
      rationale: 'y',
      summary: 'Add org guidance during build.',
    });
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('scaffold-proposal-reject'));
    expect(clearScaffoldProposalMock).toHaveBeenCalled();
    expect(createScaffoldAdditionMock).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// spec-360 issues 2 / 6 / 7 / 8 / 9 — the assistant-driven surface behaviours.
// SELECT_RING/PULSE_RING differ only in the ring colour token.
// ──────────────────────────────────────────────────────────────────────────

const SELECT_TOKEN = 'ring-accent/60';
const PULSE_TOKEN = 'ring-accent ';
const sc = (n: number) => `mindset-prod/memex-building-itself/specs/spec-360/acs/ac-${n}`;

describe('spec-360: the assistant intro is STATIC — no money-costing opening LLM turn', () => {
  it('never fires an opening LLM turn on mount (cost-free landing)', async () => {
    tagAc(sc(11));
    setupAuth('administrator');
    setupChat(null, { isScaffoldMode: true });
    renderPage();
    await screen.findByTestId('scaffold-assistant-panel');
    // The page no longer calls startScaffoldOpeningTurn — the intro is a static
    // card rendered by ChatPanel (covered in ChatPanel.test). Loading the page
    // must not invoke the agent.
    expect(startScaffoldOpeningTurnMock).not.toHaveBeenCalled();
  });
});

describe('spec-360 issue-6: scaffoldNav drives selection + pulses the control', () => {
  it('maps scaffoldNav phase target → phase selection and PULSE_RINGs the timeline pill', async () => {
    tagAc(sc(9));
    setupAuth('administrator');
    setupChat(null, { isScaffoldMode: true, scaffoldNav: { target: { phase: 'build' }, seq: 1 } });
    renderPage();
    // The detail pane selected the build phase (same target→selection mapping).
    expect(await screen.findByTestId('scaffold-phase-detail-build')).toBeInTheDocument();
    // The active timeline pill brightens to PULSE_RING right after the agent move.
    const build = screen.getByTestId('scaffold-timeline-phase-build');
    expect(build.className).toContain(PULSE_TOKEN);
    expect(build.className).not.toContain(SELECT_TOKEN);
  });

  it('maps a global (empty) target → the Always-applies band, pulsed', async () => {
    tagAc(sc(9));
    setupAuth('administrator');
    setupChat(null, { isScaffoldMode: true, scaffoldNav: { target: {}, seq: 1 } });
    renderPage();
    const band = await screen.findByTestId('scaffold-always-applies-band');
    expect(band.className).toContain(PULSE_TOKEN);
    expect(screen.getByTestId('scaffold-circumstance-global')).toBeInTheDocument();
  });

  it('maps a button target → the matching handoff button, pulsed', async () => {
    tagAc(sc(9));
    setupAuth('administrator');
    setupChat(null, {
      isScaffoldMode: true,
      scaffoldNav: { target: { button: 'opening-build-handoff' }, seq: 1 },
    });
    renderPage();
    const btn = await screen.findByTestId('scaffold-handoff-button-opening-build-handoff');
    expect(btn.className).toContain(PULSE_TOKEN);
  });
});

describe('spec-360 issue-7: persistent SELECT_RING on the manually-selected control', () => {
  it('a clicked (no-nav) phase carries SELECT_RING, not PULSE_RING', async () => {
    tagAc(sc(9));
    setupAuth('administrator');
    setupChat(null, { isScaffoldMode: true, scaffoldNav: null });
    renderPage();
    const user = userEvent.setup();
    await openBuildPhase(user);
    const build = screen.getByTestId('scaffold-timeline-phase-build');
    // Selected without a nav pulse → the steady SELECT_RING.
    expect(build.className).toContain(SELECT_TOKEN);
    // Non-selected siblings carry no ring.
    expect(screen.getByTestId('scaffold-timeline-phase-specify').className).not.toContain(
      'ring-accent',
    );
  });

  it('the Always-applies band carries SELECT_RING when selected by click', async () => {
    tagAc(sc(9));
    setupAuth('administrator');
    setupChat(null, { isScaffoldMode: true, scaffoldNav: null });
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('scaffold-always-applies-band'));
    const band = screen.getByTestId('scaffold-always-applies-band');
    expect(band.className).toContain(SELECT_TOKEN);
  });
});

describe('spec-360 issue-8: phase-handoff buttons get their own Handoffs row', () => {
  // The fixture only carries opening-build-handoff + add-comment; the dedicated
  // Handoffs row resolves the handoff ids that EXIST in the dataset, in order.
  it('renders the Handoffs row with the dataset handoff buttons; the handoff is NOT in Actions', async () => {
    tagAc(sc(9));
    setupAuth('administrator');
    renderPage();
    // Wait for the fixture data to load (add-comment is fixture-only — its
    // presence proves we're past the BASE_SCAFFOLD fallback).
    await screen.findByTestId('scaffold-action-button-add-comment');
    const shelf = screen.getByTestId('scaffold-handoffs-shelf');
    expect(
      within(shelf).getByTestId('scaffold-handoff-button-opening-build-handoff'),
    ).toBeInTheDocument();
    // The handoff button is NOT duplicated into the Actions shelf.
    const actions = screen.getByTestId('scaffold-actions-shelf');
    expect(
      within(actions).queryByTestId('scaffold-action-button-opening-build-handoff'),
    ).not.toBeInTheDocument();
    // A cross-phase action button stays in Actions, not Handoffs.
    expect(within(actions).getByTestId('scaffold-action-button-add-comment')).toBeInTheDocument();
    expect(
      within(shelf).queryByTestId('scaffold-handoff-button-add-comment'),
    ).not.toBeInTheDocument();
  });

  it('selecting a handoff button rings THAT button and leaves the Actions shelf unhighlighted', async () => {
    tagAc(sc(9));
    setupAuth('administrator');
    renderPage();
    const user = userEvent.setup();
    const handoff = await screen.findByTestId('scaffold-handoff-button-opening-build-handoff');
    await user.click(handoff);
    expect(handoff.className).toContain(SELECT_TOKEN);
    // The Actions shelf's button is not ringed.
    const action = screen.getByTestId('scaffold-action-button-add-comment');
    expect(action.className).not.toContain('ring-accent');
  });

  it('a normal action button still highlights when selected', async () => {
    tagAc(sc(9));
    setupAuth('administrator');
    renderPage();
    const user = userEvent.setup();
    const action = await screen.findByTestId('scaffold-action-button-add-comment');
    await user.click(action);
    expect(action.className).toContain(SELECT_TOKEN);
    // The handoff button is not ringed.
    expect(
      screen.getByTestId('scaffold-handoff-button-opening-build-handoff').className,
    ).not.toContain('ring-accent');
  });
});

describe('spec-360 issue-9: the home state shows the explainer + the About back-link rules', () => {
  it('home shows scaffold-explainer + scaffold-home-hint and NO About link', async () => {
    tagAc(sc(11));
    setupAuth('administrator');
    renderPage();
    expect(await screen.findByTestId('scaffold-explainer')).toBeInTheDocument();
    expect(screen.getByTestId('scaffold-home-hint')).toBeInTheDocument();
    // On home you're already there — no back link.
    expect(screen.queryByTestId('scaffold-about-link')).not.toBeInTheDocument();
  });

  it('off-home the About link appears and returns to the home explainer', async () => {
    tagAc(sc(11));
    setupAuth('administrator');
    renderPage();
    const user = userEvent.setup();
    await openBuildPhase(user);
    // Off home: the explainer is gone and the About link is present.
    expect(screen.queryByTestId('scaffold-explainer')).not.toBeInTheDocument();
    const back = screen.getByTestId('scaffold-about-link');
    await user.click(back);
    // Back home: explainer returns, About link disappears again.
    expect(await screen.findByTestId('scaffold-explainer')).toBeInTheDocument();
    expect(screen.queryByTestId('scaffold-about-link')).not.toBeInTheDocument();
  });

  it('the home explainer badge reflects canEdit — admin+org shows the admin badge', async () => {
    tagAc(sc(11));
    setupAuth('administrator');
    renderPage();
    await screen.findByTestId('scaffold-explainer');
    expect(screen.getByTestId('scaffold-role-badge')).toHaveAttribute('data-role', 'admin');
  });

  it('a non-admin member sees the viewer badge on the home explainer', async () => {
    tagAc(sc(11));
    setupAuth('member');
    renderPage();
    await screen.findByTestId('scaffold-explainer');
    expect(screen.getByTestId('scaffold-role-badge')).toHaveAttribute('data-role', 'viewer');
  });

  it('a personal memex (no org) shows the viewer badge (canEdit false without an org)', async () => {
    tagAc(sc(11));
    setupAuth('administrator');
    getOrgApiMock.mockRejectedValue(new Error('Get org failed: 404'));
    renderPage();
    await screen.findByTestId('scaffold-explainer');
    expect(screen.getByTestId('scaffold-role-badge')).toHaveAttribute('data-role', 'viewer');
  });
});

describe('spec-360 issue-9 cleanup: ScaffoldHowItWorks is gone', () => {
  it('renders no scaffold-how-it-works-toggle anywhere', async () => {
    setupAuth('administrator');
    renderPage();
    await screen.findByTestId('scaffold-timeline');
    expect(screen.queryByTestId('scaffold-how-it-works-toggle')).not.toBeInTheDocument();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// spec-360 issue-10 — review-on-manual-edit + pending-approval indicator.
// A MANUAL inline add/edit sends an assessment request to the assistant; an
// AGENT proposal-approval does NOT (the assistant already assessed). A pending
// proposal raises the amber indicator; clicking it scrolls the pane to the review.
// ──────────────────────────────────────────────────────────────────────────
describe('spec-360 issue-10: a MANUAL add asks the assistant to review it', () => {
  it('after an inline Add-here save, sendMessage fires with the review seed', async () => {
    tagAc(sc(12));
    setupAuth('administrator');
    const newBlock: GuidanceBlock & { id: string } = {
      kind: 'guidance_block', source: 'org', target: { tool: 'create_task', phase: 'build' },
      text: 'NEW INLINE NUDGE.', enabled: true, order: 9, rationale: 'why', id: 'org-new', orgId: 'org-uuid',
    };
    fetchScaffoldMock.mockResolvedValueOnce({ base: dataset, org: [orgGlobal, orgBuildStage] });
    fetchScaffoldMock.mockResolvedValue({ base: dataset, org: [orgGlobal, orgBuildStage, newBlock] });
    createScaffoldAdditionMock.mockResolvedValueOnce(newBlock);

    renderPage();
    const user = userEvent.setup();
    await openBuildPhase(user);
    await user.click(screen.getByTestId('scaffold-tool-create_task'));
    const detail = screen.getByTestId('scaffold-circumstance-nudge');
    await user.click(within(detail).getByTestId('scaffold-add-here-trigger'));
    await user.type(screen.getByTestId('scaffold-add-here-text'), 'NEW INLINE NUDGE.');
    await user.type(screen.getByTestId('scaffold-add-here-rationale'), 'why');
    await user.click(screen.getByTestId('scaffold-add-here-submit'));

    // The manual save fires the assistant-review seed (the block is already saved).
    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));
    const seed = sendMessageMock.mock.calls[0][0] as string;
    expect(typeof seed).toBe('string');
    expect(seed).toMatch(/SAVED and LIVE/);
    expect(seed).toContain('NEW INLINE NUDGE.');
  });
});

describe('spec-360 issue-10: approving an AGENT proposal does NOT re-review', () => {
  it('approving a proposal writes through create but never fires the review seed', async () => {
    tagAc(sc(2));
    createScaffoldAdditionMock.mockResolvedValue({ id: 'new' });
    setupAuth('administrator');
    setupChat({
      operation: 'add',
      target: { phase: 'build' },
      text: 'Carry an AC on every build task.',
      rationale: 'house rule',
      summary: 'Add org guidance during build.',
    });
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('scaffold-proposal-approve'));
    await waitFor(() => expect(createScaffoldAdditionMock).toHaveBeenCalled());
    // The assistant already assessed before proposing — no re-review seed.
    expect(sendMessageMock).not.toHaveBeenCalled();
  });
});

describe('spec-360 issue-10: pending-approval indicator', () => {
  it('renders the amber pending indicator when a proposal is set', async () => {
    tagAc(sc(9));
    setupAuth('administrator');
    setupChat({
      operation: 'add',
      target: { phase: 'build' },
      text: 'x',
      rationale: 'y',
      summary: 'Add org guidance during build.',
    });
    renderPage();
    expect(await screen.findByTestId('scaffold-pending-indicator')).toBeInTheDocument();
  });

  it('is absent when there is no pending proposal', async () => {
    tagAc(sc(9));
    setupAuth('administrator');
    setupChat(null);
    renderPage();
    await screen.findByTestId('scaffold-timeline');
    expect(screen.queryByTestId('scaffold-pending-indicator')).not.toBeInTheDocument();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// spec-360 issue-11 — approveProposal maps scope 'memex' to the current memexId,
// so a per-Memex addition is written scoped to this Memex; 'org' (or omitted)
// stays org-wide (no memexId).
// ──────────────────────────────────────────────────────────────────────────
describe('spec-360 issue-11: approveProposal threads scope through to the write', () => {
  it("scope 'memex' calls createScaffoldAdditionFor with memexId = the current Memex", async () => {
    tagAc(sc(2));
    createScaffoldAdditionMock.mockResolvedValue({ id: 'new' });
    setupAuth('administrator');
    setupChat({
      operation: 'add',
      target: { phase: 'build' },
      text: 'This Memex only rule.',
      rationale: 'project-specific',
      scope: 'memex',
      summary: 'Add org guidance during build (this Memex only).',
    });
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('scaffold-proposal-approve'));
    await waitFor(() =>
      expect(createScaffoldAdditionMock).toHaveBeenCalledWith(
        { kind: 'org', orgId: 'org-uuid' },
        expect.objectContaining({ text: 'This Memex only rule.', memexId: 'mx-1' }),
      ),
    );
  });

  it("scope 'org' (or omitted) writes WITHOUT a memexId (org-wide)", async () => {
    tagAc(sc(2));
    createScaffoldAdditionMock.mockResolvedValue({ id: 'new' });
    setupAuth('administrator');
    setupChat({
      operation: 'add',
      target: { phase: 'build' },
      text: 'Org-wide rule.',
      rationale: 'org policy',
      scope: 'org',
      summary: 'Add org guidance during build.',
    });
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('scaffold-proposal-approve'));
    await waitFor(() => expect(createScaffoldAdditionMock).toHaveBeenCalled());
    const arg = createScaffoldAdditionMock.mock.calls[0][1] as Record<string, unknown>;
    expect(arg).not.toHaveProperty('memexId');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// spec-360 issue-12 — page chrome: a <h1>Scaffold</h1> heading renders at the
// top of the inspect column, matching the other tenant pages.
// ──────────────────────────────────────────────────────────────────────────
describe('spec-360 issue-12: the Scaffold page heading', () => {
  it('renders an <h1>Scaffold</h1> page heading', async () => {
    tagAc(sc(11));
    setupAuth('administrator');
    renderPage();
    const heading = await screen.findByRole('heading', { level: 1, name: 'Scaffold' });
    expect(heading).toBeInTheDocument();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// spec-360 issue-14 — the chat (assistant) rail is drag-resizable on desktop:
// a handle on its right edge sets the aside width, clamped 300–720px and
// persisted to localStorage key 'scaffold-chat-width' (default 384). jsdom has
// no real layout, so we assert on the inline style.width the component sets.
// The handle attaches its mousemove/mouseup listeners to `document`.
// ──────────────────────────────────────────────────────────────────────────
describe('spec-360 issue-14: the chat rail is drag-resizable', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('renders the resize handle inside the assistant panel', async () => {
    tagAc(sc(11));
    setupAuth('administrator');
    renderPage();
    const panel = await screen.findByTestId('scaffold-assistant-panel');
    expect(within(panel).getByTestId('scaffold-chat-resize')).toBeInTheDocument();
  });

  it('starts the aside at the default 384px width with no saved width', async () => {
    tagAc(sc(11));
    setupAuth('administrator');
    renderPage();
    const panel = await screen.findByTestId('scaffold-assistant-panel');
    expect(panel.style.width).toBe('384px');
  });

  it('a mousedown on the handle + mousemove widens the aside within the clamp', async () => {
    tagAc(sc(11));
    setupAuth('administrator');
    renderPage();
    const panel = await screen.findByTestId('scaffold-assistant-panel');
    const handle = within(panel).getByTestId('scaffold-chat-resize');

    // Drag right by 100px → 384 + 100 = 484, inside [300, 720].
    fireEvent.mouseDown(handle, { clientX: 0 });
    fireEvent.mouseMove(document, { clientX: 100 });
    fireEvent.mouseUp(document);
    expect(panel.style.width).toBe('484px');
  });

  it('a mousemove that drags left narrows the aside', async () => {
    tagAc(sc(11));
    setupAuth('administrator');
    renderPage();
    const panel = await screen.findByTestId('scaffold-assistant-panel');
    const handle = within(panel).getByTestId('scaffold-chat-resize');

    // Drag left by 84px → 384 - 84 = 300 (the floor exactly).
    fireEvent.mouseDown(handle, { clientX: 200 });
    fireEvent.mouseMove(document, { clientX: 116 });
    fireEvent.mouseUp(document);
    expect(panel.style.width).toBe('300px');
  });

  it('clamps an over-wide drag to the 720px ceiling', async () => {
    tagAc(sc(11));
    setupAuth('administrator');
    renderPage();
    const panel = await screen.findByTestId('scaffold-assistant-panel');
    const handle = within(panel).getByTestId('scaffold-chat-resize');

    // Drag right by 1000px → 384 + 1000 = 1384, clamped to 720.
    fireEvent.mouseDown(handle, { clientX: 0 });
    fireEvent.mouseMove(document, { clientX: 1000 });
    fireEvent.mouseUp(document);
    expect(panel.style.width).toBe('720px');
  });

  it('clamps an over-narrow drag to the 300px floor', async () => {
    tagAc(sc(11));
    setupAuth('administrator');
    renderPage();
    const panel = await screen.findByTestId('scaffold-assistant-panel');
    const handle = within(panel).getByTestId('scaffold-chat-resize');

    // Drag left by 1000px → 384 - 1000 = -616, clamped to 300.
    fireEvent.mouseDown(handle, { clientX: 1000 });
    fireEvent.mouseMove(document, { clientX: 0 });
    fireEvent.mouseUp(document);
    expect(panel.style.width).toBe('300px');
  });

  it('restores a saved width from localStorage on mount', async () => {
    tagAc(sc(11));
    window.localStorage.setItem('scaffold-chat-width', '512');
    setupAuth('administrator');
    renderPage();
    const panel = await screen.findByTestId('scaffold-assistant-panel');
    expect(panel.style.width).toBe('512px');
  });

  it('ignores an out-of-range saved width and falls back to the default', async () => {
    tagAc(sc(11));
    // 9999 is above the 720 ceiling → not honoured; the aside starts at default.
    window.localStorage.setItem('scaffold-chat-width', '9999');
    setupAuth('administrator');
    renderPage();
    const panel = await screen.findByTestId('scaffold-assistant-panel');
    expect(panel.style.width).toBe('384px');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// spec-360 issue-14 — the Handoffs row resolves the handoff buttons that EXIST
// in the dataset, in the canonical lifecycle order: Specify(plan-handoff) →
// Review(review-handoff) → Build(opening-build-handoff) → Verify(verify-spec).
// Review sits SECOND. The base fixture only carries opening-build-handoff, so we
// extend the dataset with all four handoff ids to exercise the ordering.
// ──────────────────────────────────────────────────────────────────────────
describe('spec-360 issue-14: the Handoffs row order (Review is second)', () => {
  const allHandoffButtons: PromptButtonNode[] = [
    // Deliberately listed OUT of the rendered order, so a passing assertion
    // proves the page imposes its own order, not the dataset's.
    { kind: 'prompt_button', id: 'verify-spec', label: 'Verify handoff', text: 'VERIFY TEXT.', surfaces: ['spec'], rationale: 'r' },
    { kind: 'prompt_button', id: 'opening-build-handoff', label: 'Start building', text: 'BUILD TEXT.', surfaces: ['spec'], rationale: 'r' },
    { kind: 'prompt_button', id: 'review-handoff', label: 'Review', text: 'REVIEW TEXT.', surfaces: ['spec'], rationale: 'r' },
    { kind: 'prompt_button', id: 'plan-handoff', label: 'Specify handoff', text: 'SPECIFY TEXT.', surfaces: ['spec'], rationale: 'r' },
    { kind: 'prompt_button', id: 'add-comment', label: 'Add a comment', text: 'ADD COMMENT TEXT.', surfaces: ['spec'], rationale: 'r' },
  ];
  const allHandoffDataset: ScaffoldDataset = {
    phases, promptBlocks, tools, transitions, baseGuidance, promptButtons: allHandoffButtons,
  };

  it('renders Specify → Review → Build → Verify, with Review second', async () => {
    tagAc(sc(9));
    setupAuth('administrator');
    fetchScaffoldMock.mockResolvedValue({ base: allHandoffDataset, org: [orgGlobal, orgBuildStage] });
    renderPage();

    const shelf = await screen.findByTestId('scaffold-handoffs-shelf');
    const buttons = within(shelf).getAllByTestId(/^scaffold-handoff-button-/);
    const ids = buttons.map((b) => b.getAttribute('data-testid')?.replace('scaffold-handoff-button-', ''));
    expect(ids).toEqual(['plan-handoff', 'review-handoff', 'opening-build-handoff', 'verify-spec']);

    // The non-handoff action button is NOT pulled into the Handoffs row.
    expect(within(shelf).queryByTestId('scaffold-handoff-button-add-comment')).not.toBeInTheDocument();
  });
});
