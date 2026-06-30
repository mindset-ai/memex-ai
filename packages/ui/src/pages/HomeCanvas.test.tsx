// spec-336 — Home Onboarding v2: the Home Canvas as a persistent rail + content panel.
//
// Verifies the v2 presentation and its decisions:
//  ac-1  persistent collapsible tracker + progress + six-node rail
//  ac-8  full arc presented to a new user (not behind an opt-in walkthrough)
//  ac-9  rail (all visible steps) + content panel — not a single derived card
//  ac-13 clicking any step views it (free nav), changing neither an orb nor the %
//  ac-14 an orb ticks / the % advances only from real attainment, never from viewing
//  ac-15 last-viewed step remembered across visits; no restart control
//  ac-16 collapse uses the graduation seam (→ pearls, re-opens)
//  ac-17 no invite-colleagues modal reachable
//  ac-7/ac-10/ac-11 role branching (builder vs non-builder visible set + % denominator)
//  ac-12 non-builder handoff on the terminal "Done becomes a fact" step
//  ac-3  step 1 connects the agent + creates the spec; ac-4 the per-stage MCP prompts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';

const fetchJourneyStateApi = vi.hoisted(() => vi.fn());
const postJourneyEventApi = vi.hoisted(() => vi.fn());
const fetchDocs = vi.hoisted(() => vi.fn());

vi.mock('../api/journey', () => ({
  fetchJourneyStateApi,
  postJourneyEventApi,
}));

// spec-372 issues 13–16 — HomeCanvas fetches the user's specs to resolve the prompt
// spec token. Preserve other api/docs exports; stub fetchDocs to no specs by default.
vi.mock('../api/docs', async (orig) => ({
  ...(await orig<typeof import('../api/docs')>()),
  fetchDocs,
}));

vi.mock('../components/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-1', name: 'John Doe', email: 'john@example.com' },
    session: { memberships: [{ slug: 'john', memexSlug: 'personal', kind: 'personal' }] },
    token: 'fake',
  }),
}));

vi.mock('../hooks/useUserChangeStream', () => ({
  useUserChangeStream: () => undefined,
}));

import { HomeCanvas } from './HomeCanvas';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-336/acs/ac-${n}`;
const AC344 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-344/acs/ac-${n}`;
const AC372 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-372/acs/ac-${n}`;
const AC433 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-433/acs/ac-${n}`;

// spec-433: identity hidden. spec-421: create-first-spec added.
// HIDDEN_STEP_IDS = [identity, resolve-decision, add-ac, specs-match-reality, agents-build].
// 2 visible steps: create-spec (FIRST_STEP_ID, full-width no-rail) and create-first-spec.
const ALL_STEPS = [
  'identity',
  'create-spec',
  'create-first-spec',
  'resolve-decision',
  'add-ac',
  'specs-match-reality',
  'agents-build',
] as const;

const VISIBLE_STEPS = ['create-spec', 'create-first-spec'] as const;
const HIDDEN_STEPS = ['identity', 'resolve-decision', 'add-ac', 'specs-match-reality', 'agents-build'] as const;

const DEV_HEAVY = { dev: 0.9, design: 0.05, pm: 0.05 }; // → "All-in builder"
const DESIGN_HEAVY = { dev: 0.05, design: 0.9, pm: 0.05 }; // → "Pure designer" (non-builder)

function stepsOf(attained: readonly string[]) {
  return ALL_STEPS.map((id) => ({ id, attained: attained.includes(id) }));
}

function stateFor(
  currentStepId: string,
  over: {
    roleCoords?: { dev: number; design: number; pm: number } | null;
    attained?: readonly string[];
    canPreview?: boolean;
    preview?: boolean;
  } = {},
) {
  return {
    milestones: {},
    roleCoords: over.roleCoords ?? null,
    currentStepId,
    steps: stepsOf(over.attained ?? []),
    preview: over.preview ?? false,
    canPreview: over.canPreview ?? false,
  };
}

function LocationDisplay() {
  const loc = useLocation();
  return (
    <div data-testid="location">
      {loc.pathname}
      {loc.search}
    </div>
  );
}

function renderCanvas(entry = '/home') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <HomeCanvas />
      <LocationDisplay />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchJourneyStateApi.mockReset();
  postJourneyEventApi.mockReset();
  postJourneyEventApi.mockResolvedValue(undefined);
  fetchDocs.mockReset();
  fetchDocs.mockResolvedValue([]);
  window.localStorage.clear();
});

describe('HomeCanvas v2 — persistent rail + content panel (ac-1, ac-2, ac-8, ac-9)', () => {
  it('server returning hidden identity step for brand-new user clamps forward to create-spec (ac-1, ac-7, spec-433)', async () => {
    tagAc(AC433(1));
    tagAc(AC433(7)); // clampToVisible maps hidden identity → first visible step (create-spec)
    // Brand-new user: identityConfirmed=false → server returns currentStepId='identity'.
    // clampToVisible detects identity precedes the first visible step (create-spec) and
    // returns create-spec instead of the default last-visible fallback.
    fetchJourneyStateApi.mockResolvedValue(stateFor('identity'));
    renderCanvas();

    expect(await screen.findByTestId('journey-step-create-spec')).toBeInTheDocument();
    expect(screen.queryByTestId('journey-step-identity')).toBeNull();
    expect(screen.queryByTestId('journey-rail')).toBeNull();
  });

  it('opens a new user full-width on step 0 (create-spec, Connect MCP); the rail is hidden until they advance', async () => {
    tagAc(AC(2));
    tagAc(AC(8));
    tagAc(AC344(3)); // a normal (non-staff) user's journey renders unchanged by spec-344
    tagAc(AC433(3)); // display name drawn from SSO identity — no prompt to confirm/edit
    tagAc(AC433(6)); // FIRST_STEP_ID = 'create-spec' → full-width no-rail layout
    // spec-433: identity is hidden; create-spec is FIRST_STEP_ID (full-width, no rail).
    fetchJourneyStateApi.mockResolvedValue(stateFor('create-spec'));
    renderCanvas();

    expect(await screen.findByTestId('getting-started-title')).toBeInTheDocument();
    // create-spec is full-width on step 0 — the rail only reveals on create-first-spec (ac-2/ac-8).
    expect(screen.getByTestId('journey-step-create-spec')).toBeInTheDocument();
    expect(screen.getByTestId('connect-stage')).toBeInTheDocument();
    // No role triangle, no name input (identity step is hidden — ac-1 / ac-3).
    expect(screen.queryByTestId('journey-step-identity')).toBeNull();
    expect(screen.queryByTestId('role-triangle')).toBeNull();
    expect(screen.queryByTestId('journey-rail')).toBeNull();
    // A progress indicator at 0% for a brand-new user (derived, dec-6).
    expect(screen.getByTestId('journey-progress')).toHaveTextContent('0% complete');
  });

  it('past step 0, shows 2 visible nodes in the rail; hidden steps have no rail nodes (spec-421, spec-433)', async () => {
    const AC421 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-421/acs/ac-${n}`;
    tagAc(AC(1));
    tagAc(AC(9));
    tagAc(AC421(2)); // rail shows visible nodes (2 after spec-433)
    tagAc(AC421(3)); // hidden steps have no rail nodes
    tagAc(AC433(2)); // rail shows exactly 2 steps (Connect MCP + Create First Spec)
    tagAc(AC433(5)); // identity is in HIDDEN_STEP_IDS → absent from rail
    // spec-433: create-spec is FIRST_STEP_ID (no rail). Rail reveals on create-first-spec.
    // Use attained:[] so the create-spec subtitle is not collapsed (subtitle hides when
    // attained+not-selected; with no attainment both nodes show their subtitles).
    fetchJourneyStateApi.mockResolvedValue(stateFor('create-first-spec', { attained: [] }));
    renderCanvas();

    expect(await screen.findByTestId('journey-rail')).toBeInTheDocument();
    // spec-433: 2 visible nodes in the rail (identity is now hidden).
    for (const id of VISIBLE_STEPS) {
      expect(screen.getByTestId(`journey-rail-node-${id}`)).toBeInTheDocument();
    }
    // Hidden steps (including identity) are absent from the rail.
    for (const id of HIDDEN_STEPS) {
      expect(screen.queryByTestId(`journey-rail-node-${id}`)).toBeNull();
    }
    expect(screen.getByTestId('journey-content')).toBeInTheDocument();
    expect(screen.getByTestId('journey-step-create-first-spec')).toBeInTheDocument();
    // ac-13: create-spec rail node label and subtitle.
    tagAc(AC421(13));
    const createSpecNode = screen.getByTestId('journey-rail-node-create-spec');
    expect(createSpecNode.textContent).toContain('Connect to the Memex MCP');
    expect(createSpecNode.textContent).toContain('Connect to MCP to get the full magic of Memex');
  });
});

describe('HomeCanvas v2 — viewing is free and decoupled from attainment (ac-13, ac-14)', () => {
  it('clicking a step views it without changing any orb or the %', async () => {
    tagAc(AC(6));
    tagAc(AC(13));
    tagAc(AC(14));
    // spec-433: 2 visible steps. Rail shows on create-first-spec; 0/2 attained → 0%.
    fetchJourneyStateApi.mockResolvedValue(stateFor('create-first-spec', { attained: [] }));
    renderCanvas();

    await screen.findByTestId('journey-rail');
    const pctBefore = screen.getByTestId('journey-progress').textContent;
    expect(pctBefore).toBe('0% complete');
    // create-spec is visible and not attained.
    expect(screen.getByTestId('journey-rail-node-create-spec').getAttribute('data-attained')).toBe('false');

    // View create-spec via free navigation (rail node click) — no gating.
    // create-spec is FIRST_STEP_ID, so the rail hides after selection; content still renders.
    fireEvent.click(screen.getByTestId('journey-rail-node-create-spec'));
    expect(await screen.findByTestId('journey-step-create-spec')).toBeInTheDocument();

    // % did NOT change from merely clicking (no attainment event fired).
    expect(screen.getByTestId('journey-progress').textContent).toBe(pctBefore);
  });
});

describe('HomeCanvas v2 — remembered cursor + no restart (ac-15)', () => {
  it('remembers the last-viewed step across a remount and exposes no restart control', async () => {
    tagAc(AC(6));
    tagAc(AC(15));
    // spec-433: rail shows on create-first-spec. Navigate back to create-spec (FIRST_STEP_ID).
    fetchJourneyStateApi.mockResolvedValue(stateFor('create-first-spec', { attained: [] }));
    const { unmount } = renderCanvas();

    await screen.findByTestId('journey-rail');
    // Navigate to create-spec from the rail; create-spec is FIRST_STEP_ID so rail hides.
    fireEvent.click(screen.getByTestId('journey-rail-node-create-spec'));
    expect(await screen.findByTestId('journey-step-create-spec')).toBeInTheDocument();
    // No restart control anywhere.
    expect(screen.queryByText(/restart/i)).toBeNull();
    expect(screen.queryByTestId('journey-restart')).toBeNull();

    unmount();

    // Next visit lands back on the remembered step (create-spec, not yet attained).
    renderCanvas();
    expect(await screen.findByTestId('journey-step-create-spec')).toBeInTheDocument();
  });

  it('does NOT strand a returning user on a remembered step they have already completed', async () => {
    tagAc(AC(15));
    // Last-viewed = identity, but the server has advanced past it (identity attained,
    // now on create-spec). The remembered cursor must not pin to the done step.
    window.localStorage.setItem('memex:onboarding:viewing:u-1', 'identity');
    fetchJourneyStateApi.mockResolvedValue(stateFor('create-spec', { attained: ['identity'] }));
    renderCanvas();
    expect(await screen.findByTestId('journey-step-create-spec')).toBeInTheDocument();
    expect(screen.queryByTestId('journey-step-identity')).toBeNull();
  });
});

describe('HomeCanvas v2 — role branching (ac-7, ac-10, ac-11) — spec-421 updates', () => {
  it('spec-421: both builder and non-builder see the same 2 visible nodes; no divider (hidden steps override builder-only)', async () => {
    // spec-336 dec-3 builder branching superseded by HIDDEN_STEP_IDS; spec-433 also hides identity.
    // Both personas now see [create-spec, create-first-spec]; no build-from-codebase divider.
    tagAc(AC(7));
    tagAc(AC(10));
    tagAc(AC(11));
    const AC421 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-421/acs/ac-${n}`;
    tagAc(AC421(2));
    tagAc(AC421(3));
    // spec-433: rail shows on create-first-spec (create-spec is FIRST_STEP_ID).
    fetchJourneyStateApi.mockResolvedValue(stateFor('create-first-spec', { roleCoords: DEV_HEAVY, attained: ['create-spec'] }));
    renderCanvas();

    await screen.findByTestId('journey-rail');
    // Both 2 visible steps present for a builder.
    for (const id of VISIBLE_STEPS) {
      expect(screen.getByTestId(`journey-rail-node-${id}`)).toBeInTheDocument();
    }
    // All hidden steps are absent from the rail (including identity).
    for (const id of HIDDEN_STEPS) {
      expect(screen.queryByTestId(`journey-rail-node-${id}`)).toBeNull();
    }
    // No divider since specs-match-reality is hidden.
    expect(screen.queryByTestId('rail-divider-build')).toBeNull();
  });

  it('spec-421: a non-builder persona also sees 2 steps; hidden steps absent; % over 2', async () => {
    tagAc(AC(7));
    tagAc(AC(10));
    tagAc(AC(11));
    // spec-433: create-spec attained (1 of 2 visible) → 50%.
    fetchJourneyStateApi.mockResolvedValue(
      stateFor('create-first-spec', { roleCoords: DESIGN_HEAVY, attained: ['create-spec'] }),
    );
    renderCanvas();

    await screen.findByTestId('journey-rail');
    for (const id of VISIBLE_STEPS) {
      expect(screen.getByTestId(`journey-rail-node-${id}`)).toBeInTheDocument();
    }
    expect(screen.queryByTestId('journey-rail-node-identity')).toBeNull();
    expect(screen.queryByTestId('journey-rail-node-add-ac')).toBeNull();
    expect(screen.queryByTestId('journey-rail-node-specs-match-reality')).toBeNull();
    expect(screen.queryByTestId('journey-rail-node-agents-build')).toBeNull();
    expect(screen.queryByTestId('rail-divider-build')).toBeNull();
    expect(screen.getByTestId('journey-progress')).toHaveTextContent('50% complete');
  });
});

describe('HomeCanvas v2 — non-builder handoff (ac-12) — spec-421: always absent', () => {
  it('spec-421: the nonbuilder-handoff is never shown (add-ac is hidden; create-first-spec is the terminal visible step for all)', async () => {
    // spec-421: nonBuilderTerminal = false because add-ac is hidden from the rail.
    // Neither builder nor non-builder ever sees the handoff message.
    tagAc(AC(12));
    fetchJourneyStateApi.mockResolvedValue(
      stateFor('create-first-spec', { roleCoords: DESIGN_HEAVY, attained: ['identity', 'create-spec'] }),
    );
    renderCanvas();
    await screen.findByTestId('journey-rail');
    expect(screen.queryByTestId('nonbuilder-handoff')).toBeNull();
  });

  it('spec-421: no handoff for a builder either (all personas end at create-first-spec)', async () => {
    tagAc(AC(12));
    fetchJourneyStateApi.mockResolvedValue(
      stateFor('create-first-spec', { roleCoords: DEV_HEAVY, attained: ['identity', 'create-spec'] }),
    );
    renderCanvas();
    await screen.findByTestId('journey-rail');
    expect(screen.queryByTestId('nonbuilder-handoff')).toBeNull();
  });
});

describe('HomeCanvas rail — done steps collapse + dim (spec-372 issue-10)', () => {
  it('a done step you have moved past dims its title; the selected step stays prominent', async () => {
    tagAc(AC372(38));
    // spec-433: Viewing create-first-spec with create-spec attained.
    // create-spec is done + NOT selected → dimmed; create-first-spec is selected → prominent.
    fetchJourneyStateApi.mockResolvedValue(stateFor('create-first-spec', { attained: ['create-spec'] }));
    renderCanvas();
    await screen.findByTestId('journey-rail');

    // The title is the first font-semibold span in the node (label text varies via views).
    const doneTitle = screen.getByTestId('journey-rail-node-create-spec').querySelector('span.font-semibold');
    expect(doneTitle?.className).toContain('text-muted');

    const selectedTitle = screen.getByTestId('journey-rail-node-create-first-spec').querySelector('span.font-semibold');
    expect(selectedTitle?.className).toContain('text-heading');
    expect(selectedTitle?.className).not.toContain('text-muted');
  });
});

describe('HomeCanvas v2 — tracker is always expanded (spec-372 issue-8)', () => {
  it('has no collapse/expand chevron; the rail + panel are always shown beneath the header', async () => {
    tagAc(AC(6));
    tagAc(AC(16));
    tagAc(AC372(36));
    // spec-433: rail shows on create-first-spec.
    fetchJourneyStateApi.mockResolvedValue(stateFor('create-first-spec', { roleCoords: DEV_HEAVY, attained: ['create-spec'] }));
    renderCanvas();

    await screen.findByTestId('journey-rail');
    // spec-372 issue-8 — the in-place collapse/expand toggle + chevron were removed: the
    // tracker header is static and the rail + content are always rendered.
    expect(screen.queryByTestId('journey-collapse')).toBeNull();
    expect(screen.getByTestId('getting-started-title')).toBeInTheDocument();
    expect(screen.getByTestId('journey-content')).toBeInTheDocument();
  });

  it('spec-372 issue-7: the tracker title is theme-aware and medium weight (not blue, not bold)', async () => {
    tagAc(AC372(48));
    fetchJourneyStateApi.mockResolvedValue(stateFor('create-spec', { attained: ['identity'] }));
    renderCanvas();
    const title = await screen.findByTestId('getting-started-title');
    expect(title.className).toContain('text-foreground');
    expect(title.className).toContain('font-medium');
    expect(title.className).not.toContain('text-[#0482DC]');
    expect(title.className).not.toContain('font-bold');
  });
});

describe('HomeCanvas v2 — no invite modal (ac-17)', () => {
  it('exposes no invite-colleagues action anywhere in the journey', async () => {
    tagAc(AC(17));
    for (const id of ['identity', 'create-spec', 'resolve-decision', 'add-ac']) {
      window.localStorage.clear();
      fetchJourneyStateApi.mockResolvedValue(stateFor(id, { roleCoords: DEV_HEAVY, attained: ['identity'] }));
      const { unmount } = renderCanvas();
      await screen.findByTestId('journey-content');
      expect(screen.queryByText(/invite colleagues/i)).toBeNull();
      unmount();
    }
  });
});

describe('HomeCanvas v2 — step 1 connect + create, per-stage prompts (ac-3, ac-4) — spec-421 updates', () => {
  it('step 1 offers the MCP connect stage (Stage 2 prompt moved to CreateFirstSpecStep)', async () => {
    const AC421 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-421/acs/ac-${n}`;
    tagAc(AC(3));
    tagAc(AC421(4)); // step 2 renders MCP connect only, no "Create Your First Spec" section
    fetchJourneyStateApi.mockResolvedValue(stateFor('create-spec', { roleCoords: DEV_HEAVY, attained: ['identity'] }));
    renderCanvas();
    expect(await screen.findByTestId('journey-step-create-spec')).toBeInTheDocument();
    expect(screen.getByTestId('connect-stage')).toBeInTheDocument();
    // Stage-2 prompt moved to step 3 (CreateFirstSpecStep).
    expect(screen.queryByTestId('create-spec-prompt')).toBeNull();
  });

  it('spec-421: the hidden "specs-match-reality" and "agents-build" steps are not accessible via rail or clamping', async () => {
    const AC421 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-421/acs/ac-${n}`;
    tagAc(AC(4));
    tagAc(AC421(12)); // hidden steps produce no telemetry (not mounted, not in rail)
    // With specs-match-reality as currentStepId (hidden) and create-first-spec not yet
    // attained, the canvas clamps to create-first-spec (last visible). We keep
    // create-first-spec unattained so the journey layer stays visible (not graduated).
    fetchJourneyStateApi.mockResolvedValue(
      stateFor('specs-match-reality', { roleCoords: DEV_HEAVY, attained: ['identity', 'create-spec'] }),
    );
    renderCanvas();
    // The clamped step (create-first-spec) renders; the hidden step does not.
    expect(await screen.findByTestId('journey-step-create-first-spec')).toBeInTheDocument();
    expect(screen.queryByTestId('specs-match-reality-prompt')).toBeNull();
    expect(screen.queryByTestId('journey-rail-node-specs-match-reality')).toBeNull();
    expect(screen.queryByTestId('journey-rail-node-agents-build')).toBeNull();
  });
});

describe('HomeCanvas v2 — operator preview removed (spec-344) + document.title (regression)', () => {
  it('renders no operator preview bar, even for a canPreview staff user (spec-344 ac-5)', async () => {
    tagAc(AC344(5));
    tagAc(AC344(1)); // staff no longer sees the yellow banner
    tagAc(AC344(2)); // Home content sits at the top — same as a normal user's
    tagAc(AC344(4)); // the preview is not exposed as a persistent banner
    // The yellow "manual step switcher" banner is gone for everyone now — staff Home
    // looks like a normal user's.
    fetchJourneyStateApi.mockResolvedValue(stateFor('identity', { canPreview: true }));
    renderCanvas();
    await screen.findByTestId('getting-started-title');
    expect(screen.queryByTestId('journey-preview-bar')).toBeNull();
    expect(screen.queryByTestId('journey-info')).toBeNull();
  });

  it('still forwards the ?preview=<step> debug param to the journey-state fetch (spec-344 ac-6)', async () => {
    tagAc(AC344(6));
    tagAc(AC344(4)); // preview survives only as an opt-in URL, not a banner
    // The banner is gone but the URL capability survives: visiting /home?preview=<step>
    // reads the param and requests that previewed state (server still gates it via canPreview).
    fetchJourneyStateApi.mockResolvedValue(stateFor('create-spec', { canPreview: true, preview: true }));
    renderCanvas('/home?preview=create-spec');
    await screen.findByTestId('getting-started-title');
    expect(fetchJourneyStateApi).toHaveBeenCalledWith('create-spec');
  });

  it("sets document.title to 'Home' so the desktop shell labels the /home tab (spec-318 ac-17)", async () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-318/acs/ac-17');
    document.title = 'Specs';
    fetchJourneyStateApi.mockResolvedValue(stateFor('identity'));
    renderCanvas();
    await screen.findByTestId('getting-started-title');
    expect(document.title).toBe('Home');
  });
});

describe('HomeCanvas — spec-433 dormant code (ac-4)', () => {
  it('IdentityStep and RoleTriangle remain importable (dormant, not deleted)', async () => {
    tagAc(AC433(4));
    // Import the components dynamically to assert they are still present in the bundle.
    // This is a static existence check — the components are dormant but not removed.
    const { IdentityStep } = await import('../components/home/IdentityStep');
    const { personaLabel } = await import('../components/home/RoleTriangle');
    expect(IdentityStep).toBeDefined();
    expect(personaLabel).toBeDefined();
  });
});

describe('HomeCanvas — spec-434 intact voice infrastructure (ac-4)', () => {
  it('Specky component and voice session pipeline remain importable — no voice code removed', async () => {
    const AC434 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-434/acs/ac-${n}`;
    tagAc(AC434(4));
    const { Specky } = await import('@memex/guide-sdk');
    const { VoiceSessionPill, VoiceIcon } = await import('@memex/guide-sdk');
    expect(Specky).toBeDefined();
    expect(VoiceSessionPill).toBeDefined();
    expect(VoiceIcon).toBeDefined();
  });
});
