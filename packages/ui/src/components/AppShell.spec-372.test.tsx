// spec-372 t-11 (dec-8) — the "come back to onboarding" nudge: a subtle pulsing #0482DC dot
// on the AppShell Home nav item, shown ONLY while the onboarding journey is not graduated AND
// the active route is not /home. Hidden on /home and once graduated.
//   ac-28 (impl)
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import type { SessionPayload } from '../api/client';
import { ThemeProvider } from './ThemeContext';
import { SearchProvider } from './SearchContext';
import { AppShell } from './AppShell';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-372/acs/ac-${n}`;

const fetchJourneyStateApi = vi.hoisted(() => vi.fn());
vi.mock('../api/journey', async () => {
  const real = await vi.importActual<typeof import('../api/journey')>('../api/journey');
  return { ...real, fetchJourneyStateApi };
});

const mockSession: SessionPayload = {
  user: { id: 'u-1', email: 'alice@example.com', name: 'Alice', status: 'active', emailVerified: true },
  memberships: [
    {
      memexId: 'mx-alice',
      slug: 'alice',
      memexSlug: 'personal',
      name: 'Personal Memex',
      kind: 'personal' as const,
      role: 'administrator' as const,
    },
  ],
  currentMemexId: 'mx-alice',
  currentRole: 'administrator' as const,
  needsOnboarding: false,
  hiddenFeatures: [],
};

vi.mock('./AuthContext', async () => {
  const real = await vi.importActual<typeof import('./AuthContext')>('./AuthContext');
  return {
    ...real,
    useAuth: () => ({
      session: mockSession,
      user: { name: 'Alice', email: 'alice@example.com', picture: '' },
      token: 'fake-token',
      isAuthenticated: true,
      authError: null,
      logout: vi.fn(),
      updateSession: vi.fn(),
      acceptSession: vi.fn(),
    }),
  };
});

function journeyState(allAttained: boolean) {
  return {
    milestones: {},
    roleCoords: null,
    currentStepId: 'create-spec',
    steps: [
      { id: 'identity', attained: true },
      { id: 'create-spec', attained: allAttained },
    ],
    preview: false,
    canPreview: false,
  };
}

function renderShell(route: string) {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[route]}>
        <SearchProvider>
          <AppShell>
            <div data-testid="page-content">page</div>
          </AppShell>
        </SearchProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  fetchJourneyStateApi.mockReset();
});

describe('spec-372 t-11: come-back-to-onboarding dot (dec-8)', () => {
  it('ac-28: shows the dot when not graduated and off /home', async () => {
    tagAc(AC(28));
    fetchJourneyStateApi.mockResolvedValue(journeyState(false)); // not graduated
    renderShell('/alice/personal/specs');
    const dot = await screen.findByTestId('home-comeback-dot');
    expect(dot).toBeInTheDocument();
    // The onboarding accent colour, and the motion-safe pulse (static under reduced-motion).
    expect(dot.className).toContain('bg-[#0482DC]');
    expect(dot.className).toContain('motion-safe:animate-pulse');
  });

  it('ac-28: hides the dot on /home even when not graduated', async () => {
    tagAc(AC(28));
    fetchJourneyStateApi.mockResolvedValue(journeyState(false)); // not graduated
    renderShell('/home');
    await waitFor(() => expect(fetchJourneyStateApi).toHaveBeenCalled());
    expect(screen.queryByTestId('home-comeback-dot')).not.toBeInTheDocument();
  });

  it('ac-28: hides the dot once the journey is graduated', async () => {
    tagAc(AC(28));
    fetchJourneyStateApi.mockResolvedValue(journeyState(true)); // graduated
    renderShell('/alice/personal/specs');
    await waitFor(() => expect(fetchJourneyStateApi).toHaveBeenCalled());
    expect(screen.queryByTestId('home-comeback-dot')).not.toBeInTheDocument();
  });
});
