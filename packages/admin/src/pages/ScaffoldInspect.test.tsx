// b-68 t-13 + t-14 page-level tests.
//
//   - ac-1: Phase pane renders the four sub-panels per s-7 plus the link to
//           the outgoing gate.
//   - ac-2: matrix-pivot toggle shows the (tool × phase) grid.
//   - ac-4: live preview pane shows the merged (base + enabled Org) text.
//   - ac-3: admin can open the inline editor and submit; refresh updates UI.
//   - ac-13: non-admins see no Add/toggle affordances.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from "@memex-ai-ac/vitest";
import type {
  GuidanceBlock,
  PhaseNode,
  PromptBlockNode,
  ScaffoldDataset,
  ToolNode,
  TransitionRubric,
} from '@memex/shared';

// Tiny in-memory dataset so we can predict every projection deterministically.
const promptBlocks: PromptBlockNode[] = [
  {
    kind: 'prompt_block',
    id: 'role',
    surface: 'react_only',
    text: 'You are an agent.',
    rationale: 'Role rationale.',
  },
  {
    kind: 'prompt_block',
    id: 'mut',
    surface: 'shared_nudge',
    text: 'Confirm before mutating.',
    rationale: 'Mutation rationale.',
  },
];

const phases: PhaseNode[] = [
  {
    kind: 'phase',
    phase: 'plan',
    intent: 'shape narrative; resolve decisions',
    allowance: { allowed: ['update_section'], blocked: ['create_task'] },
    promptBlockIds: ['role'],
    rationale: 'Plan rationale.',
  },
  {
    kind: 'phase',
    phase: 'build',
    intent: 'execute against decisions',
    allowance: { allowed: ['create_task', 'update_section'], blocked: [] },
    promptBlockIds: ['role'],
    rationale: 'Build rationale.',
  },
  {
    kind: 'phase',
    phase: 'draft',
    intent: 'private authoring',
    allowance: { allowed: ['update_section'], blocked: ['create_task'] },
    promptBlockIds: ['role'],
    rationale: 'Draft rationale.',
  },
  {
    kind: 'phase',
    phase: 'verify',
    intent: 'walk acceptance criteria',
    allowance: { allowed: ['update_task'], blocked: [] },
    promptBlockIds: ['role'],
    rationale: 'Verify rationale.',
  },
  {
    kind: 'phase',
    phase: 'done',
    intent: 'read-only',
    allowance: { allowed: ['get_doc'], blocked: [] },
    promptBlockIds: ['role'],
    rationale: 'Done rationale.',
  },
];

const tools: ToolNode[] = [
  {
    kind: 'tool',
    name: 'update_section',
    summary: 'Edit a section.',
    args: '(id, content)',
    group: 'planning',
    rationale: 'update_section rationale.',
  },
  {
    kind: 'tool',
    name: 'create_task',
    summary: 'Create a build task.',
    args: '(briefRef, title)',
    group: 'build',
    rationale: 'create_task rationale.',
  },
];

const transitions: TransitionRubric[] = [
  { kind: 'transition_rubric', transition: 'plan', text: 'PLAN GATE PROSE.', rationale: 'Plan rubric rationale.' },
  { kind: 'transition_rubric', transition: 'build', text: 'BUILD GATE PROSE.', rationale: 'Build rubric rationale.' },
  { kind: 'transition_rubric', transition: 'verify', text: 'VERIFY GATE PROSE.', rationale: 'Verify rubric rationale.' },
  { kind: 'transition_rubric', transition: 'done', text: 'DONE GATE PROSE.', rationale: 'Done rubric rationale.' },
];

const baseGuidance: GuidanceBlock[] = [
  {
    kind: 'guidance_block',
    source: 'base',
    target: { phase: 'plan' },
    text: 'BASE PHASE PLAN BLOCK.',
    enabled: true,
    order: 0,
    rationale: 'Base plan guidance rationale.',
  },
  {
    kind: 'guidance_block',
    source: 'base',
    target: { tool: 'update_section', phase: 'plan' },
    text: 'BASE TOOL+PHASE NUDGE.',
    enabled: true,
    order: 1,
    rationale: 'Base tool+phase rationale.',
  },
];

const dataset: ScaffoldDataset = {
  phases,
  promptBlocks,
  tools,
  transitions,
  baseGuidance,
  promptButtons: [],
};

const enabledOrgBlock: GuidanceBlock & { id: string } = {
  kind: 'guidance_block',
  source: 'org',
  target: { phase: 'plan' },
  text: 'ORG PHASE PLAN ADDITION.',
  enabled: true,
  order: 0,
  rationale: 'Org plan rationale.',
  id: 'org-1',
  orgId: 'org-uuid',
  authorId: 'user-1',
  createdAt: '2026-05-01T00:00:00Z',
  updatedAt: '2026-05-26T00:00:00Z',
};

// Mocks. The vi.hoisted closures give us a handle to the same functions the
// page imports, while letting us tweak return values per test.
const fetchScaffoldMock = vi.hoisted(() => vi.fn());
const createScaffoldAdditionMock = vi.hoisted(() => vi.fn());
const toggleScaffoldAdditionMock = vi.hoisted(() => vi.fn());
const getOrgApiMock = vi.hoisted(() => vi.fn());

vi.mock('../api/scaffold', () => ({
  fetchScaffold: (...args: unknown[]) => fetchScaffoldMock(...args),
  createScaffoldAddition: (...args: unknown[]) => createScaffoldAdditionMock(...args),
  toggleScaffoldAddition: (...args: unknown[]) => toggleScaffoldAdditionMock(...args),
}));

vi.mock('../api/client', async () => {
  // Stub only what the page imports.
  return {
    getOrgApi: (...args: unknown[]) => getOrgApiMock(...args),
  };
});

const useAuthMock = vi.hoisted(() => vi.fn());
vi.mock('../components/AuthContext', () => ({
  useAuth: () => useAuthMock(),
}));

import { ScaffoldInspect } from './ScaffoldInspect';

function setupAuth({ role }: { role: 'member' | 'administrator' }) {
  useAuthMock.mockReturnValue({
    token: 'fake',
    session: {
      user: { id: 'u-1' },
      currentMemexId: 'mx-1',
      memberships: [
        {
          memexId: 'mx-1',
          slug: 'acme',
          memexSlug: 'main',
          name: 'Acme',
          memexName: 'Main',
          kind: 'team',
          role,
        },
      ],
    },
  });
}

function renderPage(initialPath = '/acme/main/scaffold') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <ScaffoldInspect />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getOrgApiMock.mockResolvedValue({ id: 'org-uuid', name: 'Acme', slug: 'acme' });
  fetchScaffoldMock.mockResolvedValue({ base: dataset, org: [enabledOrgBlock] });
});

describe('ScaffoldInspect — phase view (b-68 t-13)', () => {
  it('phase pane renders the four sub-panels and the outgoing-gate link (ac-1)', async () => {
    tagAc('mindset-prod/memex-building-itself/briefs/b-68/acs/ac-1');
    setupAuth({ role: 'administrator' });
    renderPage();

    const user = userEvent.setup();
    await user.click(await screen.findByTestId('scaffold-rail-phase-plan'));

    // Four sub-panels (s-7).
    expect(screen.getByTestId('scaffold-phase-system-prompt')).toBeInTheDocument();
    expect(screen.getByTestId('scaffold-phase-tool-nudges')).toBeInTheDocument();
    expect(screen.getByTestId('scaffold-phase-stage-guidance')).toBeInTheDocument();
    expect(screen.getByTestId('scaffold-phase-outgoing-gate')).toBeInTheDocument();
    // Plus live preview, which is the same view's fifth panel.
    expect(screen.getByTestId('scaffold-phase-live-preview')).toBeInTheDocument();

    // Outgoing-gate link points to →build for plan.
    const gateLink = screen.getByTestId('scaffold-phase-gate-link');
    expect(gateLink).toHaveTextContent('→build');
  });

  it('clicking the outgoing-gate link switches to the gate pane', async () => {
    tagAc('mindset-prod/memex-building-itself/briefs/b-68/acs/ac-1');
    setupAuth({ role: 'administrator' });
    renderPage();

    const user = userEvent.setup();
    await user.click(await screen.findByTestId('scaffold-rail-phase-plan'));
    await user.click(screen.getByTestId('scaffold-phase-gate-link'));

    const gateView = screen.getByTestId('scaffold-gate-view-build');
    expect(gateView).toBeInTheDocument();
    // BUILD GATE PROSE appears in both the base rubric block and the live
    // preview pane — assert on the base rubric specifically.
    const baseRubric = screen.getByTestId('scaffold-gate-base-rubric');
    expect(baseRubric).toHaveTextContent('BUILD GATE PROSE.');
  });

  it('matrix-pivot toggle shows the (tool × phase) grid (ac-2)', async () => {
    tagAc('mindset-prod/memex-building-itself/briefs/b-68/acs/ac-2');
    setupAuth({ role: 'administrator' });
    renderPage();

    const user = userEvent.setup();
    await user.click(await screen.findByTestId('scaffold-rail-matrix'));

    const matrix = screen.getByTestId('scaffold-matrix');
    expect(matrix).toBeInTheDocument();

    // Cells exist for every (tool, phase) pair in the dataset.
    for (const tool of dataset.tools) {
      for (const phase of ['draft', 'plan', 'build', 'verify', 'done']) {
        expect(
          screen.getByTestId(`scaffold-matrix-cell-${tool.name}-${phase}`),
        ).toBeInTheDocument();
      }
    }

    // The plan/update_section cell shows the composed nudge text (base + org).
    const planCell = screen.getByTestId('scaffold-matrix-cell-update_section-plan');
    expect(planCell).toHaveTextContent('BASE PHASE PLAN BLOCK.');
    expect(planCell).toHaveTextContent('BASE TOOL+PHASE NUDGE.');
    expect(planCell).toHaveTextContent('ORG PHASE PLAN ADDITION.');
  });

  it('live preview shows the merged base + enabled-Org text exactly (ac-4)', async () => {
    tagAc('mindset-prod/memex-building-itself/briefs/b-68/acs/ac-4');
    setupAuth({ role: 'administrator' });
    renderPage();

    const user = userEvent.setup();
    await user.click(await screen.findByTestId('scaffold-rail-phase-plan'));

    // The select defaults to the first phase-active tool. For phase=plan the
    // tools are [update_section, create_task] (create_task is blocked, so only
    // update_section is active). Set explicitly to keep the assertion stable.
    const select = screen.getByTestId('scaffold-phase-preview-tool-select');
    await user.selectOptions(select, 'update_section');

    const preview = screen.getByTestId('scaffold-phase-live-preview-text');
    // Composition: base phase + base tool+phase + org phase, all base before
    // org per `toNudge`.
    expect(preview.textContent).toContain('BASE PHASE PLAN BLOCK.');
    expect(preview.textContent).toContain('BASE TOOL+PHASE NUDGE.');
    expect(preview.textContent).toContain('ORG PHASE PLAN ADDITION.');
    // Order: base blocks precede org blocks.
    const baseIdx = preview.textContent!.indexOf('BASE PHASE PLAN BLOCK.');
    const orgIdx = preview.textContent!.indexOf('ORG PHASE PLAN ADDITION.');
    expect(baseIdx).toBeGreaterThan(-1);
    expect(orgIdx).toBeGreaterThan(baseIdx);
  });
});

describe('ScaffoldInspect — inline authoring (b-68 t-14)', () => {
  it('admin can open the editor, submit a new GuidanceBlock, refresh updates preview (ac-3)', async () => {
    tagAc('mindset-prod/memex-building-itself/briefs/b-68/acs/ac-3');
    setupAuth({ role: 'administrator' });

    // First load: just the base org block.
    fetchScaffoldMock.mockResolvedValueOnce({ base: dataset, org: [enabledOrgBlock] });
    // After admin submits, server returns the original + the new addition.
    const newAddition: GuidanceBlock & { id: string } = {
      kind: 'guidance_block',
      source: 'org',
      target: { phase: 'plan' },
      text: 'BRAND NEW ORG NUDGE.',
      enabled: true,
      order: 5,
      rationale: 'Author rationale.',
      id: 'org-2',
      orgId: 'org-uuid',
      authorId: 'u-1',
      createdAt: '2026-05-27T00:00:00Z',
      updatedAt: '2026-05-27T00:00:00Z',
    };
    fetchScaffoldMock.mockResolvedValueOnce({
      base: dataset,
      org: [enabledOrgBlock, newAddition],
    });
    createScaffoldAdditionMock.mockResolvedValueOnce(newAddition);

    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('scaffold-rail-phase-plan'));

    // Live preview before the addition does NOT include the new text.
    const previewBefore = screen.getByTestId('scaffold-phase-live-preview-text');
    expect(previewBefore.textContent).not.toContain('BRAND NEW ORG NUDGE.');

    // Find the Add button under stage guidance (there's also one under tool
    // nudges section in some layouts — we use the first).
    const triggers = screen.getAllByTestId('scaffold-add-guidance-trigger');
    await user.click(triggers[0]);

    await user.type(screen.getByTestId('scaffold-add-text'), 'BRAND NEW ORG NUDGE.');
    await user.type(screen.getByTestId('scaffold-add-rationale'), 'Author rationale.');
    await user.click(screen.getByTestId('scaffold-add-submit'));

    // create API called with the right shape.
    await waitFor(() => {
      expect(createScaffoldAdditionMock).toHaveBeenCalledWith(
        'org-uuid',
        expect.objectContaining({
          target: { phase: 'plan' },
          text: 'BRAND NEW ORG NUDGE.',
          rationale: 'Author rationale.',
        }),
      );
    });

    // Refetch propagates the new block — live preview now includes it.
    await waitFor(() => {
      const previewAfter = screen.getByTestId('scaffold-phase-live-preview-text');
      expect(previewAfter.textContent).toContain('BRAND NEW ORG NUDGE.');
    });
  });

  it('non-admin users do not see Add buttons (ac-13)', async () => {
    tagAc('mindset-prod/memex-building-itself/briefs/b-68/acs/ac-13');
    setupAuth({ role: 'member' });
    renderPage();

    const user = userEvent.setup();
    await user.click(await screen.findByTestId('scaffold-rail-phase-plan'));

    // Stage guidance section renders but the Add button does NOT.
    expect(screen.getByTestId('scaffold-phase-stage-guidance')).toBeInTheDocument();
    expect(screen.queryByTestId('scaffold-add-guidance-trigger')).not.toBeInTheDocument();

    // And the toggle on the existing Org block is also hidden (UI affordance
    // gated on admin role).
    expect(
      screen.queryByTestId(`scaffold-org-toggle-${enabledOrgBlock.id}`),
    ).not.toBeInTheDocument();
  });

  it('non-admin reading the gate pane sees no Add / toggle affordances (ac-13)', async () => {
    tagAc('mindset-prod/memex-building-itself/briefs/b-68/acs/ac-13');
    setupAuth({ role: 'member' });
    renderPage();

    const user = userEvent.setup();
    await user.click(await screen.findByTestId('scaffold-rail-gate-build'));

    expect(screen.getByTestId('scaffold-gate-view-build')).toBeInTheDocument();
    expect(screen.queryByTestId('scaffold-add-guidance-trigger')).not.toBeInTheDocument();
  });
});

describe('ScaffoldInspect — overview (t-12)', () => {
  it('overview pane is the default landing view and renders the explainer', async () => {
    tagAc('mindset-prod/memex-building-itself/briefs/b-68/acs/ac-15');
    setupAuth({ role: 'administrator' });
    renderPage();

    expect(await screen.findByTestId('scaffold-explainer')).toBeInTheDocument();
    // Hits the four explainer sections.
    const ov = screen.getByTestId('scaffold-explainer');
    expect(within(ov).getByText(/five phases/i)).toBeInTheDocument();
    expect(within(ov).getByText(/Two-agent parity/i)).toBeInTheDocument();
    expect(within(ov).getByText(/How nudges compose/i)).toBeInTheDocument();
    expect(within(ov).getByText(/What Org additions do/i)).toBeInTheDocument();
  });
});

// Regression guard for the b-68 follow-up: when getOrgApi fails (personal
// memex, namespace with no ownerOrgId, non-admin caller hitting the
// admin-gated endpoint), the page must still render the base scaffold and
// hide the admin affordances. The page previously bailed with "No Org
// resolved for the current tenant", contradicting D-4's "view is open to
// any active member".
describe('ScaffoldInspect — tolerates a missing Org (b-68 D-4 follow-up)', () => {
  it('renders the rail + explainer using BASE_SCAFFOLD when getOrgApi rejects', async () => {
    setupAuth({ role: 'administrator' });
    getOrgApiMock.mockRejectedValue(new Error('Get org failed: 404'));
    renderPage();

    // The page is up — left rail + overview are visible.
    expect(await screen.findByTestId('scaffold-left-rail')).toBeInTheDocument();
    expect(await screen.findByTestId('scaffold-explainer')).toBeInTheDocument();
    // No "No Org resolved" bailout copy anywhere.
    expect(screen.queryByText(/No Org resolved/)).not.toBeInTheDocument();
    // fetchScaffold is never called without an orgId.
    expect(fetchScaffoldMock).not.toHaveBeenCalled();
  });

  it('hides admin affordances when no Org resolved, even for administrators', async () => {
    setupAuth({ role: 'administrator' });
    getOrgApiMock.mockRejectedValue(new Error('Get org failed: 404'));
    renderPage();

    const user = userEvent.setup();
    await user.click(await screen.findByTestId('scaffold-rail-phase-plan'));

    // Phase view renders the base content, but the Add-guidance trigger
    // (admin-only) is not present.
    expect(screen.getByTestId('scaffold-phase-system-prompt')).toBeInTheDocument();
    expect(screen.queryByTestId('scaffold-add-guidance-trigger')).not.toBeInTheDocument();
  });
});
