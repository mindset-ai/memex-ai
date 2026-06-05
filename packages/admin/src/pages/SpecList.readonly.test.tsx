import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SpecList } from './SpecList';
import type { DocSummary } from '../api/types';
import { tagAc } from "@memex-ai-ac/vitest";

const AC_NONMEMBER_READ =
  'mindset-prod/memex-building-itself/specs/spec-111/acs/ac-1';

vi.mock('../hooks/useDocChangeStream', () => ({ useDocChangeStream: () => {} }));

const fetchDocsMock = vi.fn();
vi.mock('../api/client', () => ({
  fetchDocs: (...args: unknown[]) => fetchDocsMock(...args),
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

// The whole point of this suite: drive SpecList's write-gating off the
// access hook. `canWrite` is toggled per-test via the mocked return value.
const accessMock = vi.fn();
vi.mock('../hooks/useMemexAccess', () => ({
  useMemexAccess: () => accessMock(),
}));

function spec(over: Partial<DocSummary> = {}): DocSummary {
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
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe('SpecList — non-member read-only view (spec-111 t-8)', () => {
  it('renders spec content for a non-member but hides every create/edit control', async () => {
    tagAc(AC_NONMEMBER_READ);
    accessMock.mockReturnValue({
      isAuthenticated: true,
      membership: { source: 'visited', accessLevel: 'read' },
      canWrite: false,
      isReadOnly: true,
      isVisitedReadOnly: true,
    });
    fetchDocsMock.mockResolvedValueOnce([
      spec({ id: 's-1', title: 'Public roadmap spec', handle: 'doc-1' }),
    ]);

    render(
      <MemoryRouter>
        <SpecList />
      </MemoryRouter>,
    );

    // Full read: the spec card renders.
    expect(await screen.findByText('Public roadmap spec')).toBeInTheDocument();

    // No create: header "+ New Spec" and the column add-card are gone.
    expect(screen.queryByRole('button', { name: /New Spec/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add spec/i })).not.toBeInTheDocument();

    // No edit: the per-card actions menu (rename/share/pause/move/archive) is gone.
    expect(
      screen.queryByRole('button', { name: /Actions for Public roadmap spec/i }),
    ).not.toBeInTheDocument();
  });

  it('renders the create/edit controls for a writing member', async () => {
    tagAc(AC_NONMEMBER_READ);
    accessMock.mockReturnValue({
      isAuthenticated: true,
      membership: { source: 'org', accessLevel: 'write' },
      canWrite: true,
      isReadOnly: false,
      isVisitedReadOnly: false,
    });
    fetchDocsMock.mockResolvedValueOnce([
      spec({ id: 's-1', title: 'Member roadmap spec', handle: 'doc-1' }),
    ]);

    render(
      <MemoryRouter>
        <SpecList />
      </MemoryRouter>,
    );

    await screen.findByText('Member roadmap spec');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /New Spec/i })).toBeInTheDocument(),
    );
    expect(
      screen.getByRole('button', { name: /Actions for Member roadmap spec/i }),
    ).toBeInTheDocument();
  });
});
