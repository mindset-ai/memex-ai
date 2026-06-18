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
  return <div data-testid="location">{loc.pathname}</div>;
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
  it('renders the MD-dead splash, greets by name, and offers two CTAs', async () => {
    tagAc(AC(2));
    tagAc(AC(8));
    fetchJourneyStateApi.mockResolvedValue(stateFor('welcome'));
    renderCanvas();

    expect(await screen.findByTestId('journey-step-welcome')).toBeInTheDocument();
    expect(screen.getByText('MD files')).toBeInTheDocument();
    expect(screen.getByText('dead')).toBeInTheDocument();
    expect(screen.getByText('John')).toBeInTheDocument(); // greeting first-name
    expect(screen.getByTestId('journey-cta-primary')).toHaveTextContent('Create your first spec');
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
  for (const id of ['welcome', 'first-decision', 'connect-agent', 'use-agent', 'all-set']) {
    it(`renders the '${id}' step`, async () => {
      tagAc(AC(6));
      fetchJourneyStateApi.mockResolvedValue(stateFor(id));
      renderCanvas();
      expect(await screen.findByTestId(`journey-step-${id}`)).toBeInTheDocument();
    });
  }

  it('embeds no third-party video player in any step (impl ac-14)', async () => {
    tagAc(AC(14));
    for (const id of ['welcome', 'first-decision', 'connect-agent', 'use-agent', 'all-set']) {
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
    expect(screen.getByTestId('journey-preview-use-agent')).toBeInTheDocument();
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
    { id: 'welcome', attained: true },
    { id: 'first-decision', attained: false },
    { id: 'connect-agent', attained: true }, // attained out of order
    { id: 'use-agent', attained: false },
    { id: 'all-set', attained: false },
  ];

  it('shows the map off the welcome step, with real attainment incl. the out-of-order tick', async () => {
    tagAc(AC(4));
    fetchJourneyStateApi.mockResolvedValue(stateFor('first-decision', { steps: stepsMixed }));
    renderCanvas();
    expect(await screen.findByTestId('journey-progress-map')).toBeInTheDocument();
    expect(screen.getByTestId('journey-map-welcome').getAttribute('data-attained')).toBe('true');
    expect(screen.getByTestId('journey-map-first-decision').getAttribute('data-attained')).toBe('false');
    expect(screen.getByTestId('journey-map-connect-agent').getAttribute('data-attained')).toBe('true');
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

describe('HomeCanvas — CTA allow-list (ac-5 / impl ac-12)', () => {
  it("an 'action' CTA routes into the real flow (create_spec → personal Specs board)", async () => {
    tagAc(AC(5));
    tagAc(AC(12));
    fetchJourneyStateApi.mockResolvedValue(stateFor('welcome'));
    renderCanvas();
    fireEvent.click(await screen.findByTestId('journey-cta-primary'));
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/john/personal/specs'),
    );
  });

  it("a 'navigate' CTA moves within the canvas (Why Memex? → learn-more), no route change", async () => {
    tagAc(AC(12));
    fetchJourneyStateApi.mockResolvedValue(stateFor('welcome'));
    renderCanvas();
    fireEvent.click(await screen.findByTestId('journey-cta-secondary'));
    expect(await screen.findByTestId('journey-step-learn-more')).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/home');
  });
});
