import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import { setCachedJourneyState, resetCachedJourneyState } from '../journeys/journeyStateCache';

// A journey-state fixture with the given milestone overrides. Unactivated = 0 specs
// AND no MCP; flipping either milestone marks the user "activated" (past onboarding).
function journeyState(overrides: { hasSpec?: boolean; mcpConnected?: boolean } = {}) {
  return {
    milestones: {
      identityConfirmed: true,
      mcpConnected: false,
      mcpToolCalled: false,
      hasSpec: false,
      hasResolvedDecision: false,
      hasAc: false,
      acVerified: false,
      planGrounded: false,
      ...overrides,
    },
    roleCoords: null,
    currentStepId: 'connect',
    steps: [],
  } as unknown as Parameters<typeof setCachedJourneyState>[0];
}

// The cohort the welcome targets: 0 specs, no MCP.
const UNACTIVATED = journeyState();

// spec-502 ac-1: the wizard's step 0 appears over the featured building-itself
// surface (and only there, when the flag is on). spec-508 Part 3: that step now
// opens as the centered welcome, which morphs into the companion on OK.
const AC_SEE_IT = 'mindset-prod/memex-building-itself/specs/spec-502/acs/ac-1';
const AC_WELCOME = 'mindset-prod/memex-building-itself/specs/spec-508/acs/ac-9';

const navigate = vi.fn();
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

vi.mock('./WizardModal', () => ({
  WizardModal: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="wizard-modal">
      <button data-testid="wizard-modal-close" onClick={onClose}>
        close
      </button>
    </div>
  ),
}));

let hiddenFeatures: string[] = [];
const FEATURED = {
  kind: 'team',
  slug: 'mindset-prod',
  memexSlug: 'memex-building-itself',
  memexId: 'mx-featured',
  name: 'memex-building-itself',
  memexName: 'Memex building itself',
  source: 'featured',
};
const PERSONAL = {
  kind: 'personal',
  slug: 'alice',
  memexSlug: 'personal',
  memexId: 'mx-personal',
  name: 'Alice',
};
vi.mock('../components/AuthContext', () => ({
  useAuth: () => ({
    session: { user: { email: 'a@b.co' }, memberships: [PERSONAL, FEATURED], hiddenFeatures },
  }),
}));

function stubMatchMedia(reduce: boolean): void {
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({
    matches: reduce,
    media: q,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

import { ExploreCompanionMount } from './ExploreCompanionMount';

function renderMount(namespace: string, memex: string) {
  return render(
    <MemoryRouter initialEntries={[`/${namespace}/${memex}/trails`]}>
      <ExploreCompanionMount namespace={namespace} memex={memex} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  navigate.mockClear();
  hiddenFeatures = [];
  stubMatchMedia(true); // reduced-motion → instant welcome→companion swap in tests
  setCachedJourneyState(UNACTIVATED); // warm cache → the activation gate resolves synchronously
  // The mount reads window.location.search for the ?welcome hatch; reset it so a
  // query set by one test never leaks into the next.
  window.history.replaceState({}, '', '/');
});

afterEach(() => {
  resetCachedJourneyState();
  window.history.replaceState({}, '', '/');
});

describe('spec-502 ac-1 / spec-508 ac-9: ExploreCompanionMount', () => {
  it('opens on the centered welcome over the featured demo Memex', async () => {
    tagAc(AC_SEE_IT);
    tagAc(AC_WELCOME);
    renderMount('mindset-prod', 'memex-building-itself');
    expect(await screen.findByTestId('explore-welcome')).toBeInTheDocument();
  });

  it("does NOT show on the user's own personal Memex", () => {
    tagAc(AC_SEE_IT);
    renderMount('alice', 'personal');
    expect(screen.queryByTestId('explore-welcome')).toBeNull();
    expect(screen.queryByTestId('explore-companion')).toBeNull();
  });

  it('does NOT show when the kill-switch flag is set', () => {
    tagAc(AC_SEE_IT);
    hiddenFeatures = ['onboarding-wizard'];
    renderMount('mindset-prod', 'memex-building-itself');
    expect(screen.queryByTestId('explore-welcome')).toBeNull();
  });

  it('OK morphs to the companion whose CTA opens the wizard as a modal (no route change)', async () => {
    tagAc(AC_SEE_IT);
    renderMount('mindset-prod', 'memex-building-itself');
    fireEvent.click(await screen.findByTestId('explore-welcome-ok'));
    const cta = await screen.findByTestId('create-your-own-memex-cta');
    expect(screen.queryByTestId('wizard-modal')).toBeNull();
    fireEvent.click(cta);
    expect(screen.getByTestId('wizard-modal')).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  // spec-508 activation gate: the welcome is the UNACTIVATED-user nudge, so it must
  // not surface once the user has authored a spec or connected an agent — even while
  // they're browsing the featured demo.
  it('ac-9: does NOT show for an ACTIVATED user who already has a spec', () => {
    tagAc(AC_WELCOME);
    setCachedJourneyState(journeyState({ hasSpec: true }));
    renderMount('mindset-prod', 'memex-building-itself');
    expect(screen.queryByTestId('explore-welcome')).toBeNull();
    expect(screen.queryByTestId('explore-companion')).toBeNull();
  });

  it('ac-9: does NOT show for an ACTIVATED user who has connected an MCP (even with no spec)', () => {
    tagAc(AC_WELCOME);
    setCachedJourneyState(journeyState({ hasSpec: false, mcpConnected: true }));
    renderMount('mindset-prod', 'memex-building-itself');
    expect(screen.queryByTestId('explore-welcome')).toBeNull();
    expect(screen.queryByTestId('explore-companion')).toBeNull();
  });

  // spec-508 QA/demo hatch: `?welcome` forces the welcome over the featured surface
  // regardless of activation state, without changing the ship default.
  it('ac-9: `?welcome` forces the welcome for an ACTIVATED user on the featured demo', async () => {
    tagAc(AC_WELCOME);
    setCachedJourneyState(journeyState({ hasSpec: true })); // activated → normally hidden
    window.history.replaceState({}, '', '/mindset-prod/memex-building-itself/specs?welcome=1');
    renderMount('mindset-prod', 'memex-building-itself');
    expect(await screen.findByTestId('explore-welcome')).toBeInTheDocument();
  });

  it('ac-9: an ACTIVATED user WITHOUT `?welcome` sees nothing (the hatch is opt-in)', () => {
    tagAc(AC_WELCOME);
    setCachedJourneyState(journeyState({ hasSpec: true }));
    renderMount('mindset-prod', 'memex-building-itself');
    expect(screen.queryByTestId('explore-welcome')).toBeNull();
  });
});
