// spec-315 t-3 — the graduated home-of-value surface (component).
// ac-4 (no relevance ranking — server order preserved), ac-5 (coherent all-empty),
// ac-6 (per-Memex provenance + cross-Memex link), ac-9 (layout: where-needed above
// specs-in-flight; empty blocks collapse).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';

const fetchHomeApi = vi.hoisted(() => vi.fn());
vi.mock('../../api/home', () => ({ fetchHomeApi }));

import { HomeValue } from './HomeValue';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-315/acs/ac-${n}`;

type Over = Record<string, unknown>;
const spec = (over: Over = {}) => ({
  docId: 'd1',
  handle: 'spec-1',
  title: 'Spec One',
  memexId: 'm1',
  namespaceSlug: 'acme',
  memexSlug: 'main',
  memexName: 'Acme',
  path: '/acme/main/specs/spec-1',
  lastActivityAt: new Date('2026-06-20T10:00:00Z').toISOString(),
  ...over,
});
const need = (over: Over = {}) => ({
  commentId: 'c1',
  kind: 'mention' as const,
  snippet: 'take a look at this',
  specTitle: 'Spec One',
  path: '/acme/main/specs/spec-1#c-1',
  memexName: 'Acme',
  memexSlug: 'main',
  namespaceSlug: 'acme',
  at: new Date('2026-06-20T10:00:00Z').toISOString(),
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

describe('HomeValue (spec-315)', () => {
  it('renders where-needed above specs-in-flight, each with a provenance pill + cross-memex link (ac-9, ac-6)', async () => {
    tagAc(AC(9));
    tagAc(AC(6));
    fetchHomeApi.mockResolvedValue({ whereYoureNeeded: [need()], specsInFlight: [spec()] });
    renderHV();

    const whereNeeded = await screen.findByTestId('home-where-needed');
    const specsBlock = screen.getByTestId('home-specs-in-flight');
    // where-you're-needed comes first
    expect(
      whereNeeded.compareDocumentPosition(specsBlock) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // per-memex provenance pill
    expect(screen.getAllByTestId('memex-pill')[0]).toHaveTextContent('Acme');
    // links target the cross-memex path verbatim (not the current tenant)
    expect(screen.getByTestId('spec-in-flight-d1')).toHaveAttribute(
      'href',
      '/acme/main/specs/spec-1',
    );
    expect(screen.getByTestId('where-needed-c1')).toHaveAttribute(
      'href',
      '/acme/main/specs/spec-1#c-1',
    );
  });

  it('preserves the server order — no relevance ranking (ac-4)', async () => {
    tagAc(AC(4));
    fetchHomeApi.mockResolvedValue({
      whereYoureNeeded: [],
      specsInFlight: [spec({ docId: 'a', title: 'First' }), spec({ docId: 'b', title: 'Second' })],
    });
    renderHV();
    await screen.findByTestId('home-specs-in-flight');
    const ids = screen.getAllByTestId(/^spec-in-flight-/).map((c) => c.getAttribute('data-testid'));
    expect(ids).toEqual(['spec-in-flight-a', 'spec-in-flight-b']);
  });

  it('shows a coherent hub when nothing needs the user and nothing is in flight (ac-5)', async () => {
    tagAc(AC(5));
    fetchHomeApi.mockResolvedValue({ whereYoureNeeded: [], specsInFlight: [] });
    renderHV();
    expect(await screen.findByTestId('home-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('home-where-needed')).toBeNull();
    expect(screen.queryByTestId('home-specs-in-flight')).toBeNull();
    // coherent, not blank — the way back into work is still offered
    expect(screen.getByTestId('home-value-specs')).toBeInTheDocument();
  });

  it('collapses an empty block while showing the populated one (ac-9)', async () => {
    tagAc(AC(9));
    fetchHomeApi.mockResolvedValue({ whereYoureNeeded: [], specsInFlight: [spec()] });
    renderHV();
    await screen.findByTestId('home-specs-in-flight');
    expect(screen.queryByTestId('home-where-needed')).toBeNull(); // collapsed
    expect(screen.queryByTestId('home-empty')).toBeNull(); // not the all-empty state
  });
});
