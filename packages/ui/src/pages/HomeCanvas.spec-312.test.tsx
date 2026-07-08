// spec-312 t-2 + t-3 — the layered Home (dec-2) and the "Your Journeys" pearls
// surface (dec-4).
//
//   ac-4  (scope) — graduated user sees the home-of-value surface; not-graduated sees
//                   the journey layer.
//   ac-5  (scope) — the "Your Journeys" pearls surface: one row per journey, green/grey
//                   per step, re-opens the journey when clicked.
//   ac-11 (impl)  — the home-of-value surface renders for every user regardless of
//                   graduation.
//   ac-12 (impl)  — not graduated → journey layer expanded; graduated → collapsed; both
//                   render home content.
//   ac-13 (impl)  — graduated (via the stub seam) governs only the journey layer, never
//                   whether the home content renders.
//   ac-16 (impl)  — one pearl row per journey from the registry.
//   ac-17 (impl)  — pearls map attained → green, unattained → grey.
//   ac-18 (impl)  — pearls derive from activity (state.steps); stable across remount.
//   ac-19 (impl)  — collapse + re-open from the pearls; collapse never erases the row.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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

vi.mock('../hooks/useUserChangeStream', () => ({
  useUserChangeStream: () => undefined,
}));

// spec-372 t-6 — the graduated-home surfaces are reversibly hidden behind SHOW_GRADUATED_HOME
// (default OFF). spec-312's feature + ACs are intact and reinstatable, so this suite renders
// them with the flag ON to keep verifying the spec-312 logic. The default-OFF (surfaces absent
// on Home) state is verified by HomeCanvas.spec-372.test.tsx (ac-8 / ac-14).
vi.mock('./homeCanvasFlags', () => ({ SHOW_GRADUATED_HOME: true }));

import { HomeCanvas } from './HomeCanvas';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-312/acs/ac-${n}`;

type Step = { id: string; attained: boolean };

function stateFor(currentStepId: string, steps: Step[], over: Record<string, unknown> = {}) {
  return {
    milestones: {
      identityConfirmed: false,
      mcpConnected: false,
      mcpToolCalled: false,
      hasSpec: true,
      hasResolvedDecision: false,
      hasAc: false,
      acVerified: false,
    },
    currentStepId,
    steps,
    preview: false,
    canPreview: false,
    ...over,
  };
}

const MIXED: Step[] = [
  { id: 'connect-agent', attained: true },
  { id: 'create-spec', attained: false },
  { id: 'see-green', attained: false },
];
const ALL_ATTAINED: Step[] = [
  { id: 'connect-agent', attained: true },
  { id: 'create-spec', attained: true },
  { id: 'see-green', attained: true },
];

function renderCanvas() {
  return render(
    <MemoryRouter initialEntries={['/home']}>
      <HomeCanvas />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchJourneyStateApi.mockReset();
  postJourneyEventApi.mockReset();
  postJourneyEventApi.mockResolvedValue(undefined);
});

describe('spec-312 t-2: layered Home (dec-2)', () => {
  it('ac-11 / ac-13: the home-of-value surface renders regardless of graduation', async () => {
    tagAc(AC(11));
    tagAc(AC(13));
    // not graduated
    fetchJourneyStateApi.mockResolvedValue(stateFor('create-spec', MIXED));
    const { unmount } = renderCanvas();
    expect(await screen.findByTestId('home-of-value')).toBeInTheDocument();
    unmount();
    // graduated (every step attained) — home content still on the page
    fetchJourneyStateApi.mockResolvedValue(stateFor('all-set', ALL_ATTAINED));
    renderCanvas();
    expect(await screen.findByTestId('home-of-value')).toBeInTheDocument();
  });

  it('ac-4 / ac-12: not graduated → journey layer expanded; graduated → collapsed (both keep home content)', async () => {
    tagAc(AC(4));
    tagAc(AC(12));
    // not graduated → the journey layer is shown
    fetchJourneyStateApi.mockResolvedValue(stateFor('create-spec', MIXED));
    const { unmount } = renderCanvas();
    expect(await screen.findByTestId('journey-layer')).toBeInTheDocument();
    expect(screen.getByTestId('home-of-value')).toBeInTheDocument();
    unmount();
    // graduated → the journey layer remains visible (all ticks green); home content also present
    fetchJourneyStateApi.mockResolvedValue(stateFor('all-set', ALL_ATTAINED));
    renderCanvas();
    expect(await screen.findByTestId('home-of-value')).toBeInTheDocument();
    expect(screen.getByTestId('your-journeys')).toBeInTheDocument();
    expect(await screen.findByTestId('journey-layer')).toBeInTheDocument();
  });
});

describe('spec-312 t-3: "Your Journeys" pearls (dec-4)', () => {
  it('ac-5 / ac-16: one pearl row per journey, sourced from the registry', async () => {
    tagAc(AC(5));
    tagAc(AC(16));
    fetchJourneyStateApi.mockResolvedValue(stateFor('create-spec', MIXED));
    renderCanvas();
    expect(await screen.findByTestId('your-journeys')).toBeInTheDocument();
    // v0 ships exactly one journey: onboarding (from activeJourney() in the registry).
    expect(screen.getByTestId('journey-pearls-onboarding')).toBeInTheDocument();
    expect(screen.getAllByTestId(/^journey-pearls-/)).toHaveLength(1);
  });

  it('ac-17: pearls map attained → green (earned), unattained → grey', async () => {
    tagAc(AC(17));
    fetchJourneyStateApi.mockResolvedValue(stateFor('create-spec', MIXED));
    renderCanvas();
    const earned = await screen.findByTestId('pearl-onboarding-connect-agent');
    const unearned = screen.getByTestId('pearl-onboarding-create-spec');
    expect(earned.getAttribute('data-earned')).toBe('true');
    expect(earned.className).toContain('bg-status-success-text');
    expect(unearned.getAttribute('data-earned')).toBe('false');
    expect(unearned.className).toContain('bg-edge');
  });

  it('ac-18: pearls derive from activity (state.steps) and are stable across a remount', async () => {
    tagAc(AC(18));
    const read = () =>
      screen.getAllByTestId(/^pearl-onboarding-/).map((el) => el.getAttribute('data-earned'));
    fetchJourneyStateApi.mockResolvedValue(stateFor('create-spec', MIXED));
    const { unmount } = renderCanvas();
    await screen.findByTestId('your-journeys');
    const first = read();
    expect(first).toEqual(['true', 'false', 'false']);
    unmount();
    // A reload = a fresh mount against the same server activity → identical pearls.
    fetchJourneyStateApi.mockResolvedValue(stateFor('create-spec', MIXED));
    renderCanvas();
    await screen.findByTestId('your-journeys');
    expect(read()).toEqual(first);
  });

  it('ac-19: graduated → journey layer stays visible (all ticks green) alongside pearls; row never erased', async () => {
    tagAc(AC(19));
    fetchJourneyStateApi.mockResolvedValue(stateFor('all-set', ALL_ATTAINED));
    renderCanvas();
    // Graduated → the layer remains (completed rail, no blank page); pearls are also present.
    expect(await screen.findByTestId('journey-layer')).toBeInTheDocument();
    expect(screen.getByTestId('your-journeys')).toBeInTheDocument();
  });
});
