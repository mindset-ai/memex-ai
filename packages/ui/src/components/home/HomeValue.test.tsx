// spec-315 iteration 2 (t-7) — the graduated home-of-value surface.
// ac-10 (reuses the Pulse HotSpecCard), ac-11 (live: ~3s poll + focus refetch),
// ac-2 (a card per spec I own/worked on; click opens it), ac-5 (coherent all-empty).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';

const fetchHomeApi = vi.hoisted(() => vi.fn());
vi.mock('../../api/home', () => ({ fetchHomeApi }));

import { HomeValue } from './HomeValue';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-315/acs/ac-${n}`;

type Over = Record<string, unknown>;
const card = (over: Over = {}) => ({
  docId: 'd1',
  handle: 'spec-1',
  title: 'Spec One',
  phase: 'specify',
  narrative: 'created decision dec-2',
  health: null,
  spark: [0, 1, 2, 1, 0],
  involved: [],
  lastActivityMineMs: Date.now() - 1000,
  lastActivityAnyMs: Date.now() - 1000,
  tier: 'mine',
  memexId: 'm1',
  namespaceSlug: 'acme',
  memexSlug: 'main',
  memexName: 'Acme',
  path: '/acme/main/specs/spec-1',
  ...over,
});

function renderHV(specsPath: string | null = '/jo/personal/specs') {
  return render(
    <MemoryRouter>
      <HomeValue specsPath={specsPath} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchHomeApi.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('HomeValue (spec-315 iteration 2)', () => {
  it('renders the reused Pulse HotSpecCard per spec, with memex provenance + cross-memex link (ac-10, ac-2)', async () => {
    tagAc(AC(10));
    tagAc(AC(2));
    fetchHomeApi.mockResolvedValue({ whereYoureNeeded: [], specs: [card()] });
    renderHV();
    await screen.findByTestId('home-specs');
    // the SAME component Pulse uses
    const hotCard = screen.getByTestId('hot-spec-card');
    expect(hotCard).toHaveTextContent('Spec One');
    // cross-memex href, verbatim
    expect(hotCard).toHaveAttribute('href', '/acme/main/specs/spec-1');
    // per-memex provenance label
    expect(screen.getByTestId('memex-pill')).toHaveTextContent('Acme');
  });

  it('is live — polls ~every 3s while visible (ac-11)', async () => {
    tagAc(AC(11));
    vi.useFakeTimers();
    fetchHomeApi.mockResolvedValue({ whereYoureNeeded: [], specs: [] });
    renderHV();
    expect(fetchHomeApi).toHaveBeenCalledTimes(1); // initial load
    await vi.advanceTimersByTimeAsync(3100);
    expect(fetchHomeApi).toHaveBeenCalledTimes(2); // first poll (≤ 4s)
    await vi.advanceTimersByTimeAsync(3100);
    expect(fetchHomeApi).toHaveBeenCalledTimes(3);
  });

  it('refetches immediately on window focus (ac-11)', async () => {
    tagAc(AC(11));
    fetchHomeApi.mockResolvedValue({ whereYoureNeeded: [], specs: [] });
    renderHV();
    await waitFor(() => expect(fetchHomeApi).toHaveBeenCalledTimes(1));
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(fetchHomeApi).toHaveBeenCalledTimes(2));
  });

  it('shows a coherent hub when nothing needs the user and they own nothing (ac-5)', async () => {
    tagAc(AC(5));
    fetchHomeApi.mockResolvedValue({ whereYoureNeeded: [], specs: [] });
    renderHV();
    expect(await screen.findByTestId('home-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('home-specs')).toBeNull();
    expect(screen.queryByTestId('home-where-needed')).toBeNull();
  });

  it('collapses an empty block while showing the populated one (ac-2)', async () => {
    tagAc(AC(2));
    fetchHomeApi.mockResolvedValue({ whereYoureNeeded: [], specs: [card()] });
    renderHV();
    await screen.findByTestId('home-specs');
    expect(screen.queryByTestId('home-where-needed')).toBeNull(); // collapsed
    expect(screen.queryByTestId('home-empty')).toBeNull(); // not the all-empty state
  });
});
