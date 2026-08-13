// spec-529 t-3/t-4/t-5 — the resolution layer, the pill face, and the card.
//
// fetchDocs is mocked so the request COUNT is itself an assertion: the whole point
// of the provider is that a document mentioning many Specs makes one request, and
// that opening a card makes none.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import type { DocSummary } from '../../api/types';

vi.mock('../../api/docs', () => ({ fetchDocs: vi.fn() }));

import { fetchDocs } from '../../api/docs';
import { SpecRefStatusProvider } from './SpecRefStatusProvider';
import { SpecRefPill } from './SpecRefPill';

const mockFetchDocs = fetchDocs as unknown as ReturnType<typeof vi.fn>;

function makeDoc(over: Partial<DocSummary> = {}): DocSummary {
  return {
    id: 'id-1',
    handle: 'spec-335',
    title: 'The board becomes reliable and legible again',
    docType: 'spec',
    status: 'build',
    parentDocId: null,
    createdAt: '2026-08-01T10:00:00Z',
    statusChangedAt: '2026-08-10T10:00:00Z',
    sectionCount: 4,
    archivedAt: null,
    taskProgress: { total: 8, complete: 4, inProgress: 1, notStarted: 3 },
    ...over,
  } as DocSummary;
}

function renderPills(handles: string[]) {
  return render(
    <MemoryRouter initialEntries={['/mindset-prod/mindset-four/docs/doc-36']}>
      <SpecRefStatusProvider>
        {handles.map((h, i) => (
          <SpecRefPill key={`${h}-${i}`} handle={h} />
        ))}
      </SpecRefStatusProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.pushState({}, '', '/mindset-prod/mindset-four/docs/doc-36');
});

describe('SpecRefStatusProvider — one request per page', () => {
  it('resolves every handle on the page in a single request', async () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-529/acs/ac-4');
    mockFetchDocs.mockResolvedValue([
      makeDoc({ handle: 'spec-335' }),
      makeDoc({ id: 'id-2', handle: 'spec-373', title: 'A failed tool says why' }),
      makeDoc({ id: 'id-3', handle: 'spec-371', title: 'An unattended run' }),
    ]);

    renderPills(['spec-335', 'spec-373', 'spec-371']);

    await waitFor(() => expect(screen.getAllByTestId('spec-ref-pill')).toHaveLength(3));
    expect(mockFetchDocs).toHaveBeenCalledTimes(1);
    expect(mockFetchDocs.mock.calls[0][1].handles).toEqual([
      'spec-335',
      'spec-373',
      'spec-371',
    ]);
  });

  it('requests a repeated handle once', async () => {
    mockFetchDocs.mockResolvedValue([makeDoc()]);
    renderPills(['spec-335', 'spec-335', 'spec-335']);
    await waitFor(() => expect(mockFetchDocs).toHaveBeenCalledTimes(1));
    expect(mockFetchDocs.mock.calls[0][1].handles).toEqual(['spec-335']);
  });

  it('degrades the page to plain handles when resolution fails', async () => {
    mockFetchDocs.mockRejectedValue(new Error('network'));
    const { container } = renderPills(['spec-335']);
    await waitFor(() => expect(mockFetchDocs).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByTestId('spec-ref-pill')).not.toBeInTheDocument(),
    );
    expect(container.textContent).toBe('spec-335');
  });
});

describe('SpecRefPill — the face', () => {
  it('carries the handle and a phase chip, and nothing else', async () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-529/acs/ac-1');
    mockFetchDocs.mockResolvedValue([makeDoc()]);
    renderPills(['spec-335']);

    const pill = await screen.findByTestId('spec-ref-pill');
    expect(pill.textContent).toContain('spec-335');
    expect(pill.textContent).toContain('build');
    // Task progress is NOT on the face: repeated through a paragraph a fraction is
    // noise, and the split belongs to the card, which has room to spell it out.
    expect(pill.textContent).not.toMatch(/\d+\/\d+/);
    // The title is a full sentence; inlining it would wreck the line.
    expect(pill.textContent).not.toContain('The board becomes reliable');
  });

  it('links to the Spec within the containing Memex', async () => {
    mockFetchDocs.mockResolvedValue([makeDoc()]);
    renderPills(['spec-335']);
    const pill = await screen.findByTestId('spec-ref-pill');
    expect(pill.getAttribute('href')).toBe('/mindset-prod/mindset-four/specs/spec-335');
  });

  it('looks the same for a Spec with no tasks — the face never carried a count', async () => {
    mockFetchDocs.mockResolvedValue([makeDoc({ taskProgress: undefined })]);
    renderPills(['spec-335']);
    const pill = await screen.findByTestId('spec-ref-pill');
    expect(pill.textContent).toContain('spec-335');
    expect(pill.textContent).toContain('build');
    expect(pill.textContent).not.toMatch(/\d+\/\d+/);
  });

  it('renders an unresolvable handle as ordinary text with no pill or link', async () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-529/acs/ac-3');
    // The server answers "no such Spec" and "not yours to see" identically, and so
    // does this: no pill, no link, no hover affordance, nothing to probe.
    mockFetchDocs.mockResolvedValue([]);
    const { container } = renderPills(['spec-999']);
    await waitFor(() => expect(mockFetchDocs).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toBe('spec-999'));
    expect(screen.queryByTestId('spec-ref-pill')).not.toBeInTheDocument();
    expect(container.querySelector('a')).toBeNull();
  });

  it('renders as plain text with no provider above it', async () => {
    const { container } = render(
      <MemoryRouter>
        <SpecRefPill handle="spec-335" />
      </MemoryRouter>,
    );
    expect(container.textContent).toBe('spec-335');
    expect(mockFetchDocs).not.toHaveBeenCalled();
  });
});

describe('SpecRefCard — the whole story, without a request', () => {
  async function openCard(over: Partial<DocSummary> = {}) {
    mockFetchDocs.mockResolvedValue([makeDoc(over)]);
    renderPills([(over.handle as string) ?? 'spec-335']);
    const pill = await screen.findByTestId('spec-ref-pill');
    mockFetchDocs.mockClear();
    fireEvent.focus(pill);
    return screen.findByTestId('spec-ref-card');
  }

  it('opens on focus and fetches nothing', async () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-529/acs/ac-4');
    const card = await openCard({
      acHealth: { totalActive: 10, covered: 8, verified: 6, failing: 1, stale: 0, untested: 2 },
      lastActivity: {
        at: '2026-08-11T09:00:00Z',
        narrative: 'moved to build',
        actorName: 'a teammate',
      },
    });
    expect(card.textContent).toContain('The board becomes reliable');
    expect(card.textContent).toContain('4 of 8 tasks complete');
    expect(card.textContent).toContain('60% of 10 acceptance criteria verified');
    expect(card.textContent).toContain('moved to build');
    // Reading the card costs nothing — the status was already on the page.
    expect(mockFetchDocs).not.toHaveBeenCalled();
  });

  it('opens on tap as well as hover, so it exists on touch', async () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-529/acs/ac-2');
    mockFetchDocs.mockResolvedValue([makeDoc()]);
    renderPills(['spec-335']);
    const pill = await screen.findByTestId('spec-ref-pill');
    fireEvent.click(pill);
    expect(await screen.findByTestId('spec-ref-card')).toBeInTheDocument();
  });

  it('closes on blur', async () => {
    const card = await openCard();
    expect(card).toBeInTheDocument();
    fireEvent.blur(screen.getByTestId('spec-ref-pill'));
    await waitFor(() =>
      expect(screen.queryByTestId('spec-ref-card')).not.toBeInTheDocument(),
    );
  });

  it('says a Spec with no criteria has none — never 0% complete', async () => {
    const card = await openCard({ acHealth: undefined, taskProgress: undefined });
    // "No commitments yet" and "0% of its commitments met" are different states.
    expect(card.textContent).toContain('No acceptance criteria yet');
    expect(card.textContent).not.toContain('0%');
    expect(card.textContent).toContain('No tasks yet');
  });

  it('reports untested criteria as untested, not as failures', async () => {
    const card = await openCard({
      acHealth: { totalActive: 4, covered: 1, verified: 1, failing: 0, stale: 0, untested: 3 },
    });
    expect(card.textContent).toContain('3 untested');
    expect(card.textContent).not.toContain('failing');
  });

  it('says so when the referenced Spec is archived', async () => {
    const card = await openCard({
      archivedAt: '2026-08-09T10:00:00Z',
      archiveReason: 'absorbed into spec-510',
    });
    expect(card.textContent).toContain('Archived');
    expect(card.textContent).toContain('absorbed into spec-510');
  });

  it('says so when the referenced Spec has been superseded', async () => {
    const card = await openCard({
      supersededByDocId: 'id-9',
      supersessionNote: 'replaced by the newer board work',
    });
    // A reference to a replaced Spec that reads as live is worse than no pill.
    expect(card.textContent).toContain('Superseded');
    expect(card.textContent).toContain('replaced by the newer board work');
  });
});
