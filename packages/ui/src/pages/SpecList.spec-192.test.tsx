import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import type { SessionPayload } from '../api/client';
import { ThemeProvider } from '../components/ThemeContext';
import { SearchProvider } from '../components/SearchContext';

// spec-192 t-4: the Specs board search trigger (ac-8). Wired in SpecList's
// PageHeader actions; clicking it opens the same palette the ⌘K shortcut does.

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-192/acs/ac-${n}`;
const DIALOG = { name: 'Search this memex' } as const;

vi.mock('../hooks/useDocChangeStream', () => ({ useDocChangeStream: () => {} }));

const fetchDocsMock = vi.fn();
vi.mock('../api/client', () => ({
  fetchDocs: (...args: unknown[]) => fetchDocsMock(...args),
  updateDocStatus: vi.fn(),
  archiveDoc: vi.fn(),
  pauseDoc: vi.fn(),
  unpauseDoc: vi.fn(),
  resetHandholdDemo: vi.fn(),
}));
vi.mock('../components/NewSpecModal', () => ({ NewSpecModal: () => null }));
vi.mock('../components/ShareModal', () => ({ ShareModal: () => null }));
vi.mock('../components/RenameSpecDialog', () => ({ RenameSpecDialog: () => null }));
vi.mock('../components/MoveSpecDialog', () => ({ MoveSpecDialog: () => null }));

const { mockSession } = vi.hoisted(() => ({
  mockSession: { value: null as SessionPayload | null },
}));
vi.mock('../components/AuthContext', () => ({
  useAuth: () => ({ session: mockSession.value }),
}));

const { mockCanWrite } = vi.hoisted(() => ({ mockCanWrite: { value: false } }));
vi.mock('../hooks/useMemexAccess', () => ({
  useMemexAccess: () => ({
    isAuthenticated: false,
    membership: null,
    canWrite: mockCanWrite.value,
    isReadOnly: !mockCanWrite.value,
    isVisitedReadOnly: false,
  }),
}));

import { SpecList } from './SpecList';

beforeEach(() => {
  fetchDocsMock.mockResolvedValue([]);
  mockSession.value = null;
  mockCanWrite.value = false;
});

function renderBoard() {
  return render(
    <ThemeProvider>
      <MemoryRouter>
        <SearchProvider>
          <SpecList />
        </SearchProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

describe('spec-192 t-4: Specs board search trigger', () => {
  it('renders the trigger in the board header and clicking it opens the palette (ac-8)', async () => {
    tagAc(AC(8));
    tagAc(AC(1)); // scope ac-1: a persistent, visible trigger exists on the Specs board
    renderBoard();

    const trigger = await screen.findByTestId('search-palette-trigger-board');
    expect(screen.queryByRole('dialog', DIALOG)).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(await screen.findByRole('dialog', DIALOG)).toBeInTheDocument();
  });

  it('shows the trigger even for read-only users (search is a read action, not gated on canWrite)', async () => {
    mockCanWrite.value = false;
    renderBoard();
    expect(await screen.findByTestId('search-palette-trigger-board')).toBeInTheDocument();
    // The write-gated "+ New Spec" button is absent, but the search trigger is not.
    expect(screen.queryByRole('button', { name: /New Spec/i })).not.toBeInTheDocument();
  });
});
