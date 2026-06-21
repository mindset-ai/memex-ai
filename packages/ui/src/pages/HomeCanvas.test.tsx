// spec-303 — Home Canvas engine (component).
//
// ac-2 — a brand-new user sees the onboarding welcome step: the "MD files are dead"
//        splash, greeted by name, with a primary + secondary CTA.
// ac-5 — a fully-activated user lands on the terminal 'all-set' step.
// ac-6 — every milestone step renders in isolation; an operator sees the preview bar.
// ac-7 — the canvas records the step shown.
// impl ac-8 (compiled components), ac-12 (CTA allow-list), ac-13 (journey-only v0).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';

const fetchJourneyStateApi = vi.hoisted(() => vi.fn());
const postJourneyEventApi = vi.hoisted(() => vi.fn());

vi.mock('../api/journey', () => ({
  fetchJourneyStateApi,
  postJourneyEventApi,
}));

vi.mock('../components/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-1', name: 'John Doe', email: 'john@example.com' },
    session: { memberships: [{ slug: 'john', memexSlug: 'personal', kind: 'personal' }] },
    token: 'fake',
  }),
}));

// No SSE in component tests.
vi.mock('../hooks/useUserChangeStream', () => ({
  useUserChangeStream: () => undefined,
}));

import { HomeCanvas } from './HomeCanvas';

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-303/acs/ac-${n}`;

function stateFor(currentStepId: string, over: Record<string, unknown> = {}) {
  return {
    milestones: {
      hasSpec: false,
      hasDecision: false,
      mcpConnected: false,
      mcpToolCalled: false,
    },
    currentStepId,
    preview: false,
    canPreview: false,
    ...over,
  };
}

function LocationDisplay() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname}{loc.search}</div>;
}

function renderCanvas() {
  return render(
    <MemoryRouter initialEntries={['/home']}>
      <HomeCanvas />
      <LocationDisplay />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchJourneyStateApi.mockReset();
  postJourneyEventApi.mockReset();
  postJourneyEventApi.mockResolvedValue(undefined);
});

describe('HomeCanvas — welcome step (ac-2)', () => {
  it('renders the universal Beat-1 cold open, greets by name, and offers two CTAs', async () => {
    tagAc(AC(2));
    tagAc(AC(8));
    // spec-305 ac-1: the welcome is a universal, role-agnostic Beat-1 line (drift),
    // not the coder-specific ".md files are dead" cold open.
    tagAc('mindset-prod/memex-building-itself/specs/spec-305/acs/ac-1');
    fetchJourneyStateApi.mockResolvedValue(stateFor('welcome'));
    renderCanvas();

    expect(await screen.findByTestId('journey-step-welcome')).toBeInTheDocument();
    expect(screen.getByText('Welcome to Memex.')).toBeInTheDocument();
    expect(screen.getByText(/vibe coding viable/)).toBeInTheDocument();
    // The coder-specific ".md files" line is a Beat-2 reward, never the cold open.
    expect(screen.queryByText('.md files')).not.toBeInTheDocument();
    expect(screen.getByText('John')).toBeInTheDocument(); // greeting first-name
    expect(screen.getByTestId('journey-cta-primary')).toHaveTextContent('Get started');
    expect(screen.getByTestId('journey-cta-secondary')).toHaveTextContent('Why Memex?');
  });

  it('records that the step was shown (ac-7)', async () => {
    tagAc(AC(7));
    fetchJourneyStateApi.mockResolvedValue(stateFor('welcome'));
    renderCanvas();
    await screen.findByTestId('journey-step-welcome');
    await waitFor(() =>
      expect(postJourneyEventApi).toHaveBeenCalledWith('welcome', 'shown'),
    );
  });
});

describe('HomeCanvas — terminal step (ac-5)', () => {
  it("a fully-activated user sees the 'all-set' step", async () => {
    tagAc(AC(5));
    tagAc(AC(13));
    fetchJourneyStateApi.mockResolvedValue(
      stateFor('all-set', {
        milestones: { hasSpec: true, hasDecision: true, mcpConnected: true, mcpToolCalled: true },
      }),
    );
    renderCanvas();
    expect(await screen.findByTestId('journey-step-all-set')).toBeInTheDocument();
    expect(screen.getByText("You're all set.")).toBeInTheDocument();
  });
});

describe('HomeCanvas — every milestone step renders in isolation (ac-6)', () => {
  for (const id of ['welcome', 'connect-agent', 'create-spec', 'resolve-decision', 'add-ac', 'see-green', 'all-set']) {
    it(`renders the '${id}' step`, async () => {
      tagAc(AC(6));
      fetchJourneyStateApi.mockResolvedValue(stateFor(id));
      renderCanvas();
      expect(await screen.findByTestId(`journey-step-${id}`)).toBeInTheDocument();
    });
  }

  it('embeds no third-party video player in any step (impl ac-14)', async () => {
    tagAc(AC(14));
    for (const id of ['welcome', 'connect-agent', 'create-spec', 'resolve-decision', 'add-ac', 'see-green', 'all-set']) {
      fetchJourneyStateApi.mockResolvedValue(stateFor(id));
      const { container, unmount } = renderCanvas();
      await screen.findByTestId(`journey-step-${id}`);
      expect(container.querySelector('iframe')).toBeNull();
      expect(container.innerHTML.toLowerCase()).not.toMatch(/youtube|loom|vimeo/);
      unmount();
    }
  });

  it('shows the operator preview bar when canPreview is true', async () => {
    tagAc(AC(6));
    fetchJourneyStateApi.mockResolvedValue(stateFor('welcome', { canPreview: true }));
    renderCanvas();
    expect(await screen.findByTestId('journey-preview-bar')).toBeInTheDocument();
    expect(screen.getByTestId('journey-preview-create-spec')).toBeInTheDocument();
  });

  it('hides the preview bar for a non-operator', async () => {
    fetchJourneyStateApi.mockResolvedValue(stateFor('welcome', { canPreview: false }));
    renderCanvas();
    await screen.findByTestId('journey-step-welcome');
    expect(screen.queryByTestId('journey-preview-bar')).not.toBeInTheDocument();
  });
});

describe('HomeCanvas — attainment progress map', () => {
  const stepsMixed = [
    { id: 'connect-agent', attained: true },
    { id: 'create-spec', attained: false },
    { id: 'resolve-decision', attained: true }, // attained out of order
    { id: 'see-green', attained: false },
    { id: 'all-set', attained: false },
  ];

  it('shows the map off the welcome step, with real attainment incl. the out-of-order tick', async () => {
    tagAc(AC(4));
    fetchJourneyStateApi.mockResolvedValue(stateFor('create-spec', { steps: stepsMixed }));
    renderCanvas();
    expect(await screen.findByTestId('journey-progress-map')).toBeInTheDocument();
    expect(screen.getByTestId('journey-map-connect-agent').getAttribute('data-attained')).toBe('true');
    expect(screen.getByTestId('journey-map-create-spec').getAttribute('data-attained')).toBe('false');
    expect(screen.getByTestId('journey-map-resolve-decision').getAttribute('data-attained')).toBe('true');
  });

  it('hides the map on the cold welcome step', async () => {
    fetchJourneyStateApi.mockResolvedValue(
      stateFor('welcome', { steps: stepsMixed.map((s) => ({ ...s, attained: false })) }),
    );
    renderCanvas();
    await screen.findByTestId('journey-step-welcome');
    expect(screen.queryByTestId('journey-progress-map')).toBeNull();
  });
});

describe('HomeCanvas — document.title (spec-318 ac-17)', () => {
  it("sets document.title to 'Home' so the desktop shell labels the /home tab", async () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-318/acs/ac-17');
    // Simulate a stale title left by a previously-visited page (the bug: the
    // /home tab kept reading "Specs"). The Home Canvas is the one top-level page
    // without a PageHeader, so it must set its own title.
    document.title = 'Specs';
    fetchJourneyStateApi.mockResolvedValue(stateFor('welcome'));
    renderCanvas();
    await screen.findByTestId('journey-step-welcome');
    expect(document.title).toBe('Home');
  });
});

describe('HomeCanvas — CTA allow-list (ac-5 / impl ac-12)', () => {
  it("an 'action' CTA routes into the real flow (invite → integrations)", async () => {
    tagAc(AC(5));
    tagAc(AC(12));
    // all-set renders via the generic shell; its primary is an 'invite' action.
    fetchJourneyStateApi.mockResolvedValue(stateFor('all-set'));
    renderCanvas();
    fireEvent.click(await screen.findByTestId('journey-cta-primary'));
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/settings/integrations'),
    );
  });

  it("'Why Memex?' grows the welcome card into the lesson in place, no route change", async () => {
    tagAc(AC(12));
    fetchJourneyStateApi.mockResolvedValue(stateFor('welcome'));
    renderCanvas();
    expect(screen.queryByTestId('why-memex-lesson')).toBeNull();
    fireEvent.click(await screen.findByTestId('journey-cta-secondary'));
    expect(await screen.findByTestId('why-memex-lesson')).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/home'); // same card, no nav
  });
});
