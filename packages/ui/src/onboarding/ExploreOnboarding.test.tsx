import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import { ExploreOnboarding } from './ExploreOnboarding';

// spec-508 Part 3:
//   ac-8 — welcome and companion are two states of one shared-layout element; OK
//          morphs center→corner; reduced motion swaps instantly.
//   ac-9 — welcome shows on mount; OK (or Esc/backdrop) dismisses it to the
//          companion. Dismissal is in-memory, so a fresh mount opens on the welcome.
const AC_MORPH = 'mindset-prod/memex-building-itself/specs/spec-508/acs/ac-8';
const AC_GATE = 'mindset-prod/memex-building-itself/specs/spec-508/acs/ac-9';

// Capture telemetry without a network round-trip.
const track = vi.fn();
vi.mock('../hooks/useTelemetry', () => ({
  useTelemetry: () => ({ track, optedOut: false, setOptOut: vi.fn() }),
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

function renderOverlay(reduce = true) {
  stubMatchMedia(reduce);
  return render(
    <MemoryRouter initialEntries={['/mindset-prod/memex-building-itself/specs']}>
      <ExploreOnboarding onCreate={() => {}} memexId="mx-featured" memexName="Memex building itself" />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  track.mockClear();
});

describe('spec-508 ExploreOnboarding — welcome → companion morph', () => {
  it('ac-9: opens on the centered welcome (a non-trapping dialog with a start button), companion not shown yet', () => {
    tagAc(AC_GATE);
    renderOverlay();
    const welcome = screen.getByTestId('explore-welcome');
    expect(welcome).toBeInTheDocument();
    expect(welcome.getAttribute('role')).toBe('dialog');
    expect(screen.getByTestId('explore-welcome-ok')).toBeInTheDocument();
    expect(screen.queryByTestId('explore-companion')).toBeNull();
    expect(track).toHaveBeenCalledWith('wizard.welcome_viewed');
  });

  it('ac-8: clicking the start button replaces the welcome with the companion (morph endpoints)', async () => {
    tagAc(AC_MORPH);
    renderOverlay();
    fireEvent.click(screen.getByTestId('explore-welcome-ok'));
    expect(await screen.findByTestId('explore-companion')).toBeInTheDocument();
    expect(screen.getByTestId('create-your-own-memex-cta')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('explore-welcome')).toBeNull());
    expect(track).toHaveBeenCalledWith('wizard.welcome_ok');
  });

  it('ac-9: Esc dismisses to the companion', async () => {
    tagAc(AC_GATE);
    renderOverlay();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(await screen.findByTestId('explore-companion')).toBeInTheDocument();
  });

  it('ac-9: clicking the backdrop dismisses to the companion', async () => {
    tagAc(AC_GATE);
    renderOverlay();
    fireEvent.click(screen.getByTestId('explore-welcome-backdrop'));
    expect(await screen.findByTestId('explore-companion')).toBeInTheDocument();
  });

  it('ac-8: under prefers-reduced-motion the swap still yields the companion', async () => {
    tagAc(AC_MORPH);
    renderOverlay(true);
    fireEvent.click(screen.getByTestId('explore-welcome-ok'));
    expect(await screen.findByTestId('explore-companion')).toBeInTheDocument();
  });

  it('ac-8: the morph works with motion enabled too (endpoints unchanged)', async () => {
    tagAc(AC_MORPH);
    renderOverlay(false);
    fireEvent.click(screen.getByTestId('explore-welcome-ok'));
    expect(await screen.findByTestId('explore-companion')).toBeInTheDocument();
  });

  it('ac-9: dismissal is in-memory only — a fresh mount (refresh) returns to the welcome', async () => {
    tagAc(AC_GATE);
    // First visit: dismiss to the companion.
    const first = renderOverlay();
    fireEvent.click(screen.getByTestId('explore-welcome-ok'));
    expect(await screen.findByTestId('explore-companion')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('explore-welcome')).toBeNull());

    // Nothing was persisted — dismissal lives in component state, not storage.
    expect(window.localStorage.length).toBe(0);

    // A refresh = the component tree is torn down and re-created from scratch.
    first.unmount();
    renderOverlay();

    // The fresh mount opens on the centered welcome again (no sticky dismissal).
    expect(screen.getByTestId('explore-welcome')).toBeInTheDocument();
    expect(screen.queryByTestId('explore-companion')).toBeNull();
  });
});
