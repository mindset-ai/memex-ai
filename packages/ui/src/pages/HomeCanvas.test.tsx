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

const SIX = [
  'identity',
  'create-spec',
  'resolve-decision',
  'add-ac',
  'specs-match-reality',
  'agents-build',
] as const;

const DEV_HEAVY = { dev: 0.9, design: 0.05, pm: 0.05 }; // → "All-in builder"
const DESIGN_HEAVY = { dev: 0.05, design: 0.9, pm: 0.05 }; // → "Pure designer" (non-builder)

function stepsOf(attained: readonly string[]) {
  return SIX.map((id) => ({ id, attained: attained.includes(id) }));
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
  it('opens a new user full-width on step 0 (the identity triangle); the rail is hidden until they advance', async () => {
    tagAc(AC(2));
    tagAc(AC(8));
    tagAc(AC344(3)); // a normal (non-staff) user's journey renders unchanged by spec-344
    fetchJourneyStateApi.mockResolvedValue(stateFor('identity'));
    renderCanvas();

    expect(await screen.findByTestId('getting-started-title')).toBeInTheDocument();
    // Step 0 ("About you") is full-width — the rail only reveals once past it (ac-2/ac-8).
    expect(screen.getByTestId('journey-step-identity')).toBeInTheDocument();
    expect(screen.getByTestId('role-triangle')).toBeInTheDocument();
    expect(screen.getByTestId('persona-label')).toBeInTheDocument();
    expect(screen.queryByTestId('journey-rail')).toBeNull();
    // A progress indicator at 0% for a brand-new user (derived, dec-6).
    expect(screen.getByTestId('journey-progress')).toHaveTextContent('0% complete');
  });

  it('past step 0, shows the full six-step arc as a vertical rail beside the content panel', async () => {
    tagAc(AC(1));
    tagAc(AC(9));
    fetchJourneyStateApi.mockResolvedValue(stateFor('create-spec', { attained: ['identity'] }));
    renderCanvas();

    // The rail is present with all six nodes (not a single derived card).
    expect(await screen.findByTestId('journey-rail')).toBeInTheDocument();
    for (const id of SIX) {
      expect(screen.getByTestId(`journey-rail-node-${id}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('journey-content')).toBeInTheDocument();
    expect(screen.getByTestId('journey-step-create-spec')).toBeInTheDocument();
  });
});

describe('HomeCanvas v2 — viewing is free and decoupled from attainment (ac-13, ac-14)', () => {
  it('clicking a later step views it without changing any orb or the %', async () => {
    tagAc(AC(6));
    tagAc(AC(13));
    tagAc(AC(14));
    // identity attained → 1/6 ≈ 17%.
    fetchJourneyStateApi.mockResolvedValue(stateFor('create-spec', { attained: ['identity'] }));
    renderCanvas();

    await screen.findByTestId('journey-rail');
    const pctBefore = screen.getByTestId('journey-progress').textContent;
    expect(pctBefore).toBe('17% complete');
    // The far step is not attained.
    expect(screen.getByTestId('journey-rail-node-add-ac').getAttribute('data-attained')).toBe('false');

    // View a step the user is nowhere near — free navigation, no gating.
    fireEvent.click(screen.getByTestId('journey-rail-node-add-ac'));
    expect(await screen.findByTestId('journey-step-add-ac')).toBeInTheDocument();

    // Neither the % nor that step's orb changed from merely viewing it.
    expect(screen.getByTestId('journey-progress').textContent).toBe(pctBefore);
    expect(screen.getByTestId('journey-rail-node-add-ac').getAttribute('data-attained')).toBe('false');
    expect(screen.getByTestId('journey-rail-node-identity').getAttribute('data-attained')).toBe('true');
  });
});

describe('HomeCanvas v2 — remembered cursor + no restart (ac-15)', () => {
  it('remembers the last-viewed step across a remount and exposes no restart control', async () => {
    tagAc(AC(6));
    tagAc(AC(15));
    // Start past step 0 so the rail is shown and navigable.
    fetchJourneyStateApi.mockResolvedValue(stateFor('create-spec', { attained: ['identity'] }));
    const { unmount } = renderCanvas();

    await screen.findByTestId('journey-rail');
    fireEvent.click(screen.getByTestId('journey-rail-node-add-ac'));
    expect(await screen.findByTestId('journey-step-add-ac')).toBeInTheDocument();
    // No restart control anywhere.
    expect(screen.queryByText(/restart/i)).toBeNull();
    expect(screen.queryByTestId('journey-restart')).toBeNull();

    unmount();

    // Next visit lands back on the remembered step.
    renderCanvas();
    expect(await screen.findByTestId('journey-step-add-ac')).toBeInTheDocument();
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

describe('HomeCanvas v2 — role branching (ac-7, ac-10, ac-11)', () => {
  it('a builder persona sees all six steps and the build-from-codebase divider', async () => {
    tagAc(AC(7));
    tagAc(AC(10));
    tagAc(AC(11));
    fetchJourneyStateApi.mockResolvedValue(stateFor('create-spec', { roleCoords: DEV_HEAVY, attained: ['identity'] }));
    renderCanvas();

    await screen.findByTestId('journey-rail');
    expect(screen.getByTestId('journey-rail-node-specs-match-reality')).toBeInTheDocument();
    expect(screen.getByTestId('journey-rail-node-agents-build')).toBeInTheDocument();
    expect(screen.getByTestId('rail-divider-build')).toBeInTheDocument();
  });

  it('a non-builder persona sees only the first four steps; the % is over those four', async () => {
    tagAc(AC(7));
    tagAc(AC(10));
    tagAc(AC(11));
    // 3 of 4 visible attained → 75% (the denominator excludes the two builder steps).
    fetchJourneyStateApi.mockResolvedValue(
      stateFor('add-ac', { roleCoords: DESIGN_HEAVY, attained: ['identity', 'create-spec', 'resolve-decision'] }),
    );
    renderCanvas();

    await screen.findByTestId('journey-rail');
    expect(screen.getByTestId('journey-rail-node-add-ac')).toBeInTheDocument();
    expect(screen.queryByTestId('journey-rail-node-specs-match-reality')).toBeNull();
    expect(screen.queryByTestId('journey-rail-node-agents-build')).toBeNull();
    expect(screen.queryByTestId('rail-divider-build')).toBeNull();
    expect(screen.getByTestId('journey-progress')).toHaveTextContent('75% complete');
  });
});

describe('HomeCanvas v2 — non-builder handoff (ac-12)', () => {
  it('shows the handoff message on the terminal "Done becomes a fact" step for a non-builder', async () => {
    tagAc(AC(12));
    fetchJourneyStateApi.mockResolvedValue(
      stateFor('add-ac', { roleCoords: DESIGN_HEAVY, attained: ['identity', 'create-spec', 'resolve-decision'] }),
    );
    renderCanvas();

    expect(await screen.findByTestId('nonbuilder-handoff')).toBeInTheDocument();
    expect(screen.getByTestId('nonbuilder-handoff')).toHaveTextContent(/hand it off to a human or a coding agent/i);
  });

  it('does NOT show the handoff for a builder', async () => {
    tagAc(AC(12));
    fetchJourneyStateApi.mockResolvedValue(
      stateFor('add-ac', { roleCoords: DEV_HEAVY, attained: ['identity', 'create-spec', 'resolve-decision'] }),
    );
    renderCanvas();
    await screen.findByTestId('journey-rail');
    expect(screen.queryByTestId('nonbuilder-handoff')).toBeNull();
  });
});

describe('HomeCanvas rail — done steps collapse + dim (spec-372 issue-10)', () => {
  it('a done step you have moved past dims its title; the selected step stays prominent', async () => {
    tagAc(AC372(38));
    // Viewing create-spec with identity attained: identity is done + NOT selected → dimmed;
    // create-spec is the selected step → heading colour (not dimmed).
    fetchJourneyStateApi.mockResolvedValue(stateFor('create-spec', { attained: ['identity'] }));
    renderCanvas();
    await screen.findByTestId('journey-rail');

    // The title is the first font-semibold span in the node (label text varies via views).
    const doneTitle = screen.getByTestId('journey-rail-node-identity').querySelector('span.font-semibold');
    expect(doneTitle?.className).toContain('text-muted');

    const selectedTitle = screen.getByTestId('journey-rail-node-create-spec').querySelector('span.font-semibold');
    expect(selectedTitle?.className).toContain('text-heading');
    expect(selectedTitle?.className).not.toContain('text-muted');
  });
});

describe('HomeCanvas v2 — tracker is always expanded (spec-372 issue-8)', () => {
  it('has no collapse/expand chevron; the rail + panel are always shown beneath the header', async () => {
    tagAc(AC(6));
    tagAc(AC(16));
    tagAc(AC372(36));
    fetchJourneyStateApi.mockResolvedValue(stateFor('create-spec', { roleCoords: DEV_HEAVY, attained: ['identity'] }));
    renderCanvas();

    await screen.findByTestId('journey-rail');
    // spec-372 issue-8 — the in-place collapse/expand toggle + chevron were removed: the
    // tracker header is static and the rail + content are always rendered.
    expect(screen.queryByTestId('journey-collapse')).toBeNull();
    expect(screen.getByTestId('getting-started-title')).toBeInTheDocument();
    expect(screen.getByTestId('journey-content')).toBeInTheDocument();
  });

  it('spec-372 issue-7: the tracker title is black and medium weight (not blue, not bold)', async () => {
    tagAc(AC372(48));
    fetchJourneyStateApi.mockResolvedValue(stateFor('create-spec', { attained: ['identity'] }));
    renderCanvas();
    const title = await screen.findByTestId('getting-started-title');
    expect(title.className).toContain('text-black');
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

describe('HomeCanvas v2 — step 1 connect + create, per-stage prompts (ac-3, ac-4)', () => {
  it('step 1 offers the MCP connect stage and the create-spec prompt', async () => {
    tagAc(AC(3));
    fetchJourneyStateApi.mockResolvedValue(stateFor('create-spec', { roleCoords: DEV_HEAVY, attained: ['identity'] }));
    renderCanvas();
    expect(await screen.findByTestId('journey-step-create-spec')).toBeInTheDocument();
    expect(screen.getByTestId('connect-stage')).toBeInTheDocument();
    expect(screen.getByTestId('create-spec-prompt')).toBeInTheDocument();
  });

  it('the builder-only "specs-match-reality" and "agents-build" steps carry their copyable prompts', async () => {
    tagAc(AC(4));
    fetchJourneyStateApi.mockResolvedValue(
      stateFor('specs-match-reality', { roleCoords: DEV_HEAVY, attained: ['identity', 'create-spec', 'resolve-decision', 'add-ac'] }),
    );
    const { unmount } = renderCanvas();
    expect(await screen.findByTestId('specs-match-reality-prompt')).toBeInTheDocument();
    expect(screen.getByTestId('specs-match-reality-outcomes')).toBeInTheDocument();
    unmount();
    // Fresh visit (clear the remembered viewing cursor the first render persisted).
    window.localStorage.clear();

    fetchJourneyStateApi.mockResolvedValue(
      stateFor('agents-build', { roleCoords: DEV_HEAVY, attained: ['identity', 'create-spec', 'resolve-decision', 'add-ac', 'specs-match-reality'] }),
    );
    renderCanvas();
    expect(await screen.findByTestId('agents-build-prompt')).toBeInTheDocument();
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
