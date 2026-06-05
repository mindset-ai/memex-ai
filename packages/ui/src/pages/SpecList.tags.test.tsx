import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { SpecList } from './SpecList';
import type { DocSummary, Tag } from '../api/types';
import { tagAc } from '@memex-ai-ac/vitest';

// spec-136 t-5 (ac-4) + t-7 (ac-3). This file is TAGGED (tagAc) — it POSTs an AC
// event to PROD memex.ai on completion. Do NOT run it from an automated process;
// a human runs the tagged suite. Verify with tsc / build / UNTAGGED suites only.
//
// Develop adaptation: SpecList's loadDocs ALWAYS sends an options object with
// `include: ['acHealth', 'assignees', 'tags']` (develop attaches tags only under
// include=tags). The tag facet is layered on top when a filter is selected, and
// dropped when it's empty — so the no-filter call shape carries `include` but no
// `tags` key, and the filtered call adds `tags: [...]`.

const INCLUDE = ['acHealth', 'assignees', 'tags'];

vi.mock('../hooks/useDocChangeStream', () => ({
  useDocChangeStream: () => {},
}));

const fetchDocsMock = vi.fn();
const fetchMemexTagsMock = vi.fn();
vi.mock('../api/client', () => ({
  fetchDocs: (...args: unknown[]) => fetchDocsMock(...args),
  fetchMemexTags: () => fetchMemexTagsMock(),
  updateDocStatus: vi.fn(),
  archiveDoc: vi.fn(),
  pauseDoc: vi.fn(),
  unpauseDoc: vi.fn(),
}));

vi.mock('../components/NewSpecModal', () => ({ NewSpecModal: () => null }));
vi.mock('../components/ShareModal', () => ({ ShareModal: () => null }));
vi.mock('../components/RenameSpecDialog', () => ({ RenameSpecDialog: () => null }));
vi.mock('../components/MoveSpecDialog', () => ({ MoveSpecDialog: () => null }));
vi.mock('../components/AuthContext', () => ({ useAuth: () => ({ session: null }) }));
vi.mock('../components/CreateOrgBanner', () => ({ CreateOrgBanner: () => null }));

let nextId = 0;
function tag(over: Partial<Tag> = {}): Tag {
  return {
    id: `tag-${nextId++}`,
    memexId: 'mx-1',
    scope: null,
    value: 'bug',
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function spec(overrides: Partial<DocSummary> = {}): DocSummary {
  return {
    id: 's-1',
    handle: 'doc-1',
    title: 'Untitled spec',
    docType: 'spec',
    status: 'draft',
    parentDocId: null,
    createdAt: '2025-01-01T00:00:00Z',
    statusChangedAt: '2025-01-01T00:00:00Z',
    sectionCount: 0,
    pausedAt: null,
    archivedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  nextId = 0;
  window.localStorage.clear();
  fetchMemexTagsMock.mockResolvedValue([]);
});

describe('SpecList tags — ac-4 (chips render on Spec cards)', () => {
  it('renders the list-payload tags as chips on a card', async () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-136/acs/ac-4');
    fetchDocsMock.mockResolvedValue([
      spec({
        id: 's-1',
        title: 'Tagged spec',
        handle: 'doc-1',
        tags: [tag({ scope: 'priority', value: 'high' }), tag({ scope: null, value: 'bug' })],
      }),
    ]);

    render(
      <MemoryRouter>
        <SpecList />
      </MemoryRouter>,
    );

    await screen.findByText('Tagged spec');
    const tagsWrap = screen.getByTestId('spec-card-tags');
    const chips = within(tagsWrap).getAllByTestId('tag-chip');
    expect(chips).toHaveLength(2);
    expect(tagsWrap).toHaveTextContent('priority');
    expect(tagsWrap).toHaveTextContent('high');
    expect(tagsWrap).toHaveTextContent('bug');
  });

  it('requests the board with include=tags so cards can render chips', async () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-136/acs/ac-4');
    fetchDocsMock.mockResolvedValue([]);

    render(
      <MemoryRouter>
        <SpecList />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(fetchDocsMock).toHaveBeenCalledWith('spec', { include: INCLUDE });
    });
  });
});

describe('SpecList tag filter — ac-3 (board narrows by selected tags)', () => {
  it('re-queries the board with the selected tag and narrows results', async () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-136/acs/ac-3');
    const user = userEvent.setup();

    const highTag = tag({ scope: 'priority', value: 'high' });
    fetchMemexTagsMock.mockResolvedValue([highTag]);

    // Initial (unfiltered) load returns two specs; the filtered load returns one.
    fetchDocsMock
      .mockResolvedValueOnce([
        spec({ id: 's-1', title: 'High prio spec', handle: 'doc-1' }),
        spec({ id: 's-2', title: 'Other spec', handle: 'doc-2' }),
      ])
      .mockResolvedValueOnce([
        spec({ id: 's-1', title: 'High prio spec', handle: 'doc-1' }),
      ]);

    render(
      <MemoryRouter>
        <SpecList />
      </MemoryRouter>,
    );

    // Both specs visible before filtering. First call carried include but no tags.
    await screen.findByText('High prio spec');
    expect(screen.getByText('Other spec')).toBeInTheDocument();
    expect(fetchDocsMock).toHaveBeenNthCalledWith(1, 'spec', { include: INCLUDE });

    // Open the filter, pick priority::high.
    await user.click(screen.getByTestId('tag-filter-toggle'));
    const option = await screen.findByTestId('tag-filter-option');
    await user.click(option);

    // Board re-queries with the tag facet (AND-across / OR-within semantics).
    await waitFor(() => {
      expect(fetchDocsMock).toHaveBeenLastCalledWith('spec', {
        include: INCLUDE,
        tags: ['priority::high'],
      });
    });

    // The board narrows: the non-matching spec drops out.
    await waitFor(() => {
      expect(screen.queryByText('Other spec')).not.toBeInTheDocument();
    });
    expect(screen.getByText('High prio spec')).toBeInTheDocument();
  });

  it('clears the filter and restores the full board', async () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-136/acs/ac-3');
    const user = userEvent.setup();

    const highTag = tag({ scope: 'priority', value: 'high' });
    fetchMemexTagsMock.mockResolvedValue([highTag]);

    fetchDocsMock
      .mockResolvedValueOnce([
        spec({ id: 's-1', title: 'High prio spec', handle: 'doc-1' }),
        spec({ id: 's-2', title: 'Other spec', handle: 'doc-2' }),
      ])
      .mockResolvedValueOnce([spec({ id: 's-1', title: 'High prio spec', handle: 'doc-1' })])
      .mockResolvedValueOnce([
        spec({ id: 's-1', title: 'High prio spec', handle: 'doc-1' }),
        spec({ id: 's-2', title: 'Other spec', handle: 'doc-2' }),
      ]);

    render(
      <MemoryRouter>
        <SpecList />
      </MemoryRouter>,
    );

    await screen.findByText('High prio spec');
    await user.click(screen.getByTestId('tag-filter-toggle'));
    await user.click(await screen.findByTestId('tag-filter-option'));

    await waitFor(() => {
      expect(screen.queryByText('Other spec')).not.toBeInTheDocument();
    });

    // Clear restores the unfiltered query (include but no tags) and the full board.
    await user.click(screen.getByTestId('tag-filter-clear'));
    await waitFor(() => {
      expect(fetchDocsMock).toHaveBeenLastCalledWith('spec', { include: INCLUDE });
    });
    expect(await screen.findByText('Other spec')).toBeInTheDocument();
  });
});
