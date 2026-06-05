// spec-179 — the Insights page + nav entry.
//
// The Nivo chart components are mocked (jsdom has no layout, so Responsive*
// charts render nothing measurable); these tests own the page's wiring:
// fetch → loading/empty/ready states, per-tenant scoping, and the nav gate.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import { Insights } from './Insights';
import { AppShell } from '../components/AppShell';
import { ThemeProvider } from '../components/ThemeContext';

const AC_NAV = 'mindset-prod/memex-building-itself/specs/spec-179/acs/ac-14';
const AC_PAGE = 'mindset-prod/memex-building-itself/specs/spec-179/acs/ac-15';
const AC_OVER_TIME = 'mindset-prod/memex-building-itself/specs/spec-179/acs/ac-1';
const AC_ROUTE = 'mindset-prod/memex-building-itself/specs/spec-179/acs/ac-17';

// ── chart mocks (presentation tested visually; page owns wiring) ────────────
vi.mock('../components/insights/SpecsOverTimeChart', () => ({
  SpecsOverTimeChart: ({ points }: { points: unknown[] }) => (
    <div data-testid="mock-over-time" data-points={points.length} />
  ),
}));
vi.mock('../components/insights/SpecsByPhaseChart', () => ({
  SpecsByPhaseChart: () => <div data-testid="mock-by-phase" />,
}));
vi.mock('../components/insights/PhaseDurationsChart', () => ({
  PhaseDurationsChart: () => <div data-testid="mock-durations" />,
}));
vi.mock('../components/insights/PipelineFunnelChart', () => ({
  PipelineFunnelChart: () => <div data-testid="mock-funnel" />,
}));
vi.mock('../components/insights/ActivityStreamChart', () => ({
  ActivityStreamChart: () => <div data-testid="mock-activity" />,
}));
vi.mock('../components/insights/AcVerificationChart', () => ({
  AcVerificationChart: () => <div data-testid="mock-verification" />,
}));
vi.mock('../components/insights/AcsOverTimeChart', () => ({
  AcsOverTimeChart: () => <div data-testid="mock-acs-over-time" />,
}));
vi.mock('../components/insights/TestRunVolumeChart', () => ({
  TestRunVolumeChart: () => <div data-testid="mock-test-runs" />,
}));

// ── api mocks ────────────────────────────────────────────────────────────────
const fetchSpecsOverTime = vi.fn();
const fetchSpecsByPhase = vi.fn();
const fetchPhaseDurations = vi.fn();
const fetchPipelineFunnel = vi.fn();
const fetchActivityByActor = vi.fn();
const fetchAcVerification = vi.fn();
const fetchAcsOverTime = vi.fn();
const fetchTestRunVolume = vi.fn();
// Partial mock: AppShell's hooks (drift inbox count, …) pull other exports
// from the client module, so everything else passes through unmocked.
vi.mock(import('../api/client'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchSpecsOverTime: (...a: unknown[]) => fetchSpecsOverTime(...a),
    fetchSpecsByPhase: (...a: unknown[]) => fetchSpecsByPhase(...a),
    fetchPhaseDurations: (...a: unknown[]) => fetchPhaseDurations(...a),
    fetchPipelineFunnel: (...a: unknown[]) => fetchPipelineFunnel(...a),
    fetchActivityByActor: (...a: unknown[]) => fetchActivityByActor(...a),
    fetchAcVerification: (...a: unknown[]) => fetchAcVerification(...a),
    fetchAcsOverTime: (...a: unknown[]) => fetchAcsOverTime(...a),
    fetchTestRunVolume: (...a: unknown[]) => fetchTestRunVolume(...a),
  };
});

const POINTS = [
  { day: '2026-06-01', created: 2, cumulative: 2 },
  { day: '2026-06-02', created: 1, cumulative: 3 },
  { day: '2026-06-03', created: 2, cumulative: 5 },
];
const BY_PHASE = [{ day: '2026-06-01', draft: 1, plan: 0, build: 0, verify: 0, done: 1 }];
const DURATIONS = {
  inPhase: [{ phase: 'draft', n: 1, avgDays: 2, medianDays: 2, maxDays: 2 }],
  cycleTime: { n: 1, avgDays: 1, medianDays: 1, p25Days: 1, p75Days: 1, maxDays: 1, valuesDays: [1] },
};

const FUNNEL = [
  { phase: 'draft', count: 3 },
  { phase: 'plan', count: 2 },
  { phase: 'build', count: 1 },
  { phase: 'verify', count: 1 },
  { phase: 'done', count: 1 },
];
const ACTIVITY = [{ day: '2026-06-01', human: 3, mcp_agent: 8, in_app_agent: 1 }];
const VERIFICATION = { total: 10, verified: 6, failing: 1, untested: 3 };

beforeEach(() => {
  fetchSpecsOverTime.mockReset().mockResolvedValue(POINTS);
  fetchSpecsByPhase.mockReset().mockResolvedValue(BY_PHASE);
  fetchPhaseDurations.mockReset().mockResolvedValue(DURATIONS);
  fetchPipelineFunnel.mockReset().mockResolvedValue(FUNNEL);
  fetchActivityByActor.mockReset().mockResolvedValue(ACTIVITY);
  fetchAcVerification.mockReset().mockResolvedValue(VERIFICATION);
  fetchAcsOverTime.mockReset().mockResolvedValue([{ day: '2026-06-01', created: 5, verified: 3 }]);
  fetchTestRunVolume.mockReset().mockResolvedValue([{ day: '2026-06-01', pass: 40, fail: 2, error: 0 }]);
});

function renderInsights(path = '/acme/team/insights') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/:namespace/:memex/insights" element={<Insights />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Insights page (spec-179)', () => {
  it('renders the three charts from the analytics endpoints (ac-1, ac-15)', async () => {
    tagAc(AC_OVER_TIME);
    tagAc(AC_PAGE);
    // ac-17 (route half): /:namespace/:memex/insights resolves and renders for
    // an authorized session; the API-surface 404 half lives in the server's
    // analytics.integration tenancy test.
    tagAc(AC_ROUTE);
    renderInsights();
    expect(screen.getByTestId('insights-loading')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByTestId('mock-over-time')).toBeInTheDocument());
    expect(screen.getByTestId('mock-over-time').dataset.points).toBe('3');
    expect(screen.getByTestId('mock-by-phase')).toBeInTheDocument();
    expect(screen.getByTestId('mock-durations')).toBeInTheDocument();
    // ac-18: the follow-on charts render alongside the original three.
    tagAc('mindset-prod/memex-building-itself/specs/spec-179/acs/ac-18');
    expect(screen.getByTestId('mock-funnel')).toBeInTheDocument();
    expect(screen.getByTestId('mock-activity')).toBeInTheDocument();
    expect(screen.getByTestId('mock-verification')).toBeInTheDocument();
    // ac-19: ACs created-vs-verified + test-run volume.
    tagAc('mindset-prod/memex-building-itself/specs/spec-179/acs/ac-19');
    expect(screen.getByTestId('mock-acs-over-time')).toBeInTheDocument();
    expect(screen.getByTestId('mock-test-runs')).toBeInTheDocument();
    expect(screen.getByText('5 total')).toBeInTheDocument();
    // The stacked chart carries its honesty caveat (Design, s-7).
    expect(screen.getByText('phases shown as of today')).toBeInTheDocument();
  });

  it('shows the unlock empty state for young memexes instead of empty axes', async () => {
    tagAc(AC_PAGE);
    fetchSpecsOverTime.mockResolvedValue([{ day: '2026-06-01', created: 1, cumulative: 1 }]);
    renderInsights();
    await waitFor(() => expect(screen.getByTestId('insights-empty')).toBeInTheDocument());
    expect(screen.queryByTestId('mock-over-time')).not.toBeInTheDocument();
  });

  it('surfaces fetch failures as an error state', async () => {
    tagAc(AC_PAGE);
    fetchSpecsByPhase.mockRejectedValue(new Error('boom'));
    renderInsights();
    await waitFor(() => expect(screen.getByTestId('insights-error')).toBeInTheDocument());
  });

  it('re-fetches when the tenant in the URL changes (ac-15)', async () => {
    tagAc(AC_PAGE);
    render(
      <MemoryRouter initialEntries={['/acme/team/insights']}>
        <Routes>
          <Route
            path="/:namespace/:memex/insights"
            element={
              <>
                <Link to="/acme/other/insights" data-testid="switch-tenant">
                  switch
                </Link>
                <Insights />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(fetchSpecsOverTime).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId('switch-tenant'));
    await waitFor(() => expect(fetchSpecsOverTime).toHaveBeenCalledTimes(2));
  });
});

// ── nav gating (ac-14) — mirrors the pulse hiddenFeatures pattern ────────────

type Membership = {
  memexId: string;
  slug: string;
  memexSlug: string;
  name: string;
  memexName: string;
  kind: 'team' | 'personal';
  role: 'administrator' | 'member';
};

const TEAM: Membership = {
  memexId: 'm1',
  slug: 'acme',
  memexSlug: 'team',
  name: 'Acme Inc',
  memexName: 'Team',
  kind: 'team',
  role: 'administrator',
};

const mockSession: { user: object; memberships: Membership[]; currentMemexId: string; hiddenFeatures?: string[] } = {
  user: { name: 'Tester', email: 't@acme.test' },
  memberships: [TEAM],
  currentMemexId: 'm1',
};

vi.mock('../components/AuthContext', () => ({
  useAuth: () => ({
    user: { name: 'Tester', email: 't@acme.test' },
    session: mockSession,
    logout: vi.fn(),
  }),
}));
vi.mock('../components/MemexSwitcher', () => ({
  MemexSwitcher: () => <div data-testid="memex-switcher" />,
}));

function renderShell() {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={['/acme/team/specs']}>
        <AppShell>
          <div data-testid="page-content">page</div>
        </AppShell>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

describe('Insights nav entry (ac-14)', () => {
  it('appears in the primary nav after Pulse and routes to /insights', () => {
    tagAc(AC_NAV);
    delete mockSession.hiddenFeatures;
    renderShell();
    const link = screen.getByRole('link', { name: /insights/i });
    expect(link).toHaveAttribute('href', '/acme/team/insights');
  });

  it('is hidden when the session lists the insights feature slug', () => {
    tagAc(AC_NAV);
    mockSession.hiddenFeatures = ['insights'];
    renderShell();
    expect(screen.queryByRole('link', { name: /insights/i })).not.toBeInTheDocument();
    delete mockSession.hiddenFeatures;
  });
});
