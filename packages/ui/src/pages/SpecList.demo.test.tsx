// spec-178 (A-UI, t-8): the Specs board's demo surfaces.
//   ac-3 / ac-12: a DEMO badge marks each is_demo card; real specs carry none.
//   ac-11:        non-demo specs render unchanged (no badge).
//   ac-18:        the Reset-demo button shows ONLY when ≥1 demo spec is present.
//   ac-19:        clicking Reset confirms before hitting the reset endpoint.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { SpecList } from './SpecList';
import type { DocSummary } from '../api/types';
import { tagAc } from '@memex-ai-ac/vitest';

const SPEC_178 = 'mindset-prod/memex-building-itself/specs/spec-178';
const AC = (n: number) => `${SPEC_178}/acs/ac-${n}`;

// Hermetic: useDocChangeStream opens a real EventSource otherwise.
vi.mock('../hooks/useDocChangeStream', () => ({
  useDocChangeStream: () => {},
}));

const fetchDocsMock = vi.fn();
const resetHandholdDemoMock = vi.fn();
vi.mock('../api/client', () => ({
  fetchDocs: (...args: unknown[]) => fetchDocsMock(...args),
  updateDocStatus: vi.fn(),
  archiveDoc: vi.fn(),
  pauseDoc: vi.fn(),
  unpauseDoc: vi.fn(),
  resetHandholdDemo: (...args: unknown[]) => resetHandholdDemoMock(...args),
}));

// The Reset button reads the current tenant for the namespace/memex it POSTs to.
const { mockTenant } = vi.hoisted(() => ({
  mockTenant: { value: { namespace: 'alice', memex: 'personal' } as { namespace: string; memex: string } | null },
}));
vi.mock('../utils/tenantUrl', async () => {
  const actual = await vi.importActual<typeof import('../utils/tenantUrl')>('../utils/tenantUrl');
  return {
    ...actual,
    getCurrentTenant: () => mockTenant.value,
  };
});

vi.mock('../components/NewSpecModal', () => ({ NewSpecModal: () => null }));
vi.mock('../components/ShareModal', () => ({ ShareModal: () => null }));
vi.mock('../components/RenameSpecDialog', () => ({ RenameSpecDialog: () => null }));
vi.mock('../components/MoveSpecDialog', () => ({ MoveSpecDialog: () => null }));
vi.mock('../components/CreateOrgBanner', () => ({ CreateOrgBanner: () => null }));

vi.mock('../components/AuthContext', () => ({
  useAuth: () => ({ session: null }),
}));

// Reset / New-Spec controls gate on write access; default to writable here so the
// demo-management surfaces actually render (jsdom would otherwise pin canWrite false).
const { mockCanWrite } = vi.hoisted(() => ({ mockCanWrite: { value: true } }));
vi.mock('../hooks/useMemexAccess', () => ({
  useMemexAccess: () => ({
    isAuthenticated: true,
    membership: null,
    canWrite: mockCanWrite.value,
    isReadOnly: !mockCanWrite.value,
    isVisitedReadOnly: false,
  }),
}));

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
  mockCanWrite.value = true;
  mockTenant.value = { namespace: 'alice', memex: 'personal' };
  // The reveal pointer persists in localStorage keyed by tenant — clear it so
  // each test starts from the default 'draft' phase.
  try {
    window.localStorage.clear();
  } catch {
    /* jsdom always has storage; guard anyway */
  }
});

// spec-178 t-10 (dec-10): the five demo specs, one per phase. Shared by the
// progressive-reveal tests below — fetchDocs returns all five, the board reveals
// one at a time.
const DEMO_PHASES = ['draft', 'plan', 'build', 'verify', 'done'] as const;
function demoSet() {
  return DEMO_PHASES.map((phase, i) =>
    spec({
      id: `demo-${phase}`,
      title: `Demo ${phase}`,
      handle: `spec-${i + 1}`,
      status: phase,
      isDemo: true,
    }),
  );
}

describe('SpecList demo badge (spec-178)', () => {
  it('ac-3/ac-12: a DEMO badge marks an is_demo card and not a real one', async () => {
    tagAc(AC(3));
    tagAc(AC(12));
    fetchDocsMock.mockResolvedValueOnce([
      spec({ id: 'demo-1', title: 'Demo spec', handle: 'spec-1', isDemo: true }),
      spec({ id: 'real-1', title: 'Real spec', handle: 'spec-2' }),
    ]);

    render(
      <MemoryRouter>
        <SpecList />
      </MemoryRouter>,
    );

    const demoCard = (await screen.findByText('Demo spec')).closest('a')!;
    const realCard = screen.getByText('Real spec').closest('a')!;
    // The demo card carries the DEMO badge — the visible Badge label plus the
    // sr-only test hook (both read "DEMO"), so it appears inside the demo card.
    expect(within(demoCard).getAllByText('DEMO').length).toBeGreaterThan(0);
    expect(within(demoCard).getByTestId('spec-demo-pill')).toBeInTheDocument();
    // The real card has neither the badge nor the pill.
    expect(within(realCard).queryByText('DEMO')).not.toBeInTheDocument();
    expect(within(realCard).queryByTestId('spec-demo-pill')).not.toBeInTheDocument();
    // Exactly one DEMO pill across the board.
    expect(screen.getAllByTestId('spec-demo-pill')).toHaveLength(1);
  });

  it('ac-11: a board of only real specs shows no DEMO badge anywhere', async () => {
    tagAc(AC(11));
    fetchDocsMock.mockResolvedValueOnce([
      spec({ id: 'real-1', title: 'Real spec A', handle: 'spec-1' }),
      spec({ id: 'real-2', title: 'Real spec B', handle: 'spec-2' }),
    ]);

    render(
      <MemoryRouter>
        <SpecList />
      </MemoryRouter>,
    );

    await screen.findByText('Real spec A');
    expect(screen.queryByText('DEMO')).not.toBeInTheDocument();
    expect(screen.queryByTestId('spec-demo-pill')).not.toBeInTheDocument();
  });
});

describe('SpecList reset-demo button (spec-178)', () => {
  it('ac-18: the Reset-demo button is ABSENT when no demo specs are present', async () => {
    tagAc(AC(18));
    fetchDocsMock.mockResolvedValueOnce([
      spec({ id: 'real-1', title: 'Real spec', handle: 'spec-1' }),
    ]);

    render(
      <MemoryRouter>
        <SpecList />
      </MemoryRouter>,
    );

    await screen.findByText('Real spec');
    expect(screen.queryByTestId('reset-demo-button')).not.toBeInTheDocument();
  });

  it('ac-18: the Reset-demo button is PRESENT when ≥1 demo spec is on the board', async () => {
    tagAc(AC(18));
    fetchDocsMock.mockResolvedValueOnce([
      spec({ id: 'demo-1', title: 'Demo spec', handle: 'spec-1', isDemo: true }),
      spec({ id: 'real-1', title: 'Real spec', handle: 'spec-2' }),
    ]);

    render(
      <MemoryRouter>
        <SpecList />
      </MemoryRouter>,
    );

    await screen.findByText('Demo spec');
    expect(screen.getByTestId('reset-demo-button')).toBeInTheDocument();
  });

  it('ac-19: clicking Reset confirms BEFORE calling the endpoint — cancel aborts', async () => {
    tagAc(AC(19));
    const user = userEvent.setup();
    fetchDocsMock.mockResolvedValue([
      spec({ id: 'demo-1', title: 'Demo spec', handle: 'spec-1', isDemo: true }),
    ]);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(
      <MemoryRouter>
        <SpecList />
      </MemoryRouter>,
    );

    await screen.findByTestId('reset-demo-button');
    await user.click(screen.getByTestId('reset-demo-button'));

    // Confirm was asked; the user declined → the endpoint was never hit.
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(resetHandholdDemoMock).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('ac-19: confirming fires the reset for the current tenant, then refetches', async () => {
    tagAc(AC(19));
    const user = userEvent.setup();
    fetchDocsMock.mockResolvedValue([
      spec({ id: 'demo-1', title: 'Demo spec', handle: 'spec-1', isDemo: true }),
    ]);
    resetHandholdDemoMock.mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(
      <MemoryRouter>
        <SpecList />
      </MemoryRouter>,
    );

    await screen.findByTestId('reset-demo-button');
    // One initial board load before the click.
    expect(fetchDocsMock).toHaveBeenCalledTimes(1);

    await user.click(screen.getByTestId('reset-demo-button'));

    await waitFor(() =>
      expect(resetHandholdDemoMock).toHaveBeenCalledWith('alice', 'personal'),
    );
    // After the reset the board refetches (a second loadDocs call).
    await waitFor(() => expect(fetchDocsMock).toHaveBeenCalledTimes(2));
    confirmSpy.mockRestore();
  });
});

describe('SpecList progressive reveal (spec-178)', () => {
  it('ac-33/ac-34: first view reveals ONLY the draft demo; real specs are unaffected', async () => {
    tagAc(AC(33));
    tagAc(AC(34));
    fetchDocsMock.mockResolvedValue([
      ...demoSet(),
      spec({ id: 'real-1', title: 'Real spec', handle: 'spec-99', status: 'plan' }),
    ]);

    render(
      <MemoryRouter>
        <SpecList />
      </MemoryRouter>,
    );

    // Only the draft demo shows; the other four demo phases are hidden.
    await screen.findByText('Demo draft');
    expect(screen.queryByText('Demo plan')).not.toBeInTheDocument();
    expect(screen.queryByText('Demo build')).not.toBeInTheDocument();
    expect(screen.queryByText('Demo verify')).not.toBeInTheDocument();
    expect(screen.queryByText('Demo done')).not.toBeInTheDocument();
    // A non-demo spec at the same phase is untouched by the reveal filter.
    expect(screen.getByText('Real spec')).toBeInTheDocument();
    // Exactly one demo card → exactly one advance control on the board.
    expect(screen.getAllByTestId('demo-advance-control')).toHaveLength(1);
  });

  it('ac-34: the advance control is ABSENT on a non-demo card', async () => {
    tagAc(AC(34));
    fetchDocsMock.mockResolvedValue([
      spec({ id: 'demo-draft', title: 'Demo draft', handle: 'spec-1', status: 'draft', isDemo: true }),
      spec({ id: 'real-1', title: 'Real spec', handle: 'spec-2', status: 'draft' }),
    ]);

    render(
      <MemoryRouter>
        <SpecList />
      </MemoryRouter>,
    );

    const realCard = (await screen.findByText('Real spec')).closest('a')!;
    const realCardWrapper = realCard.parentElement!;
    // The advance control lives on the demo card only — never within a real card.
    expect(within(realCardWrapper).queryByTestId('demo-advance-control')).not.toBeInTheDocument();
    // The single board-wide advance control belongs to the demo card.
    expect(screen.getAllByTestId('demo-advance-control')).toHaveLength(1);
  });

  it('ac-33/ac-34: advancing reveals ONLY the next (plan) demo and bumps the pointer', async () => {
    tagAc(AC(33));
    tagAc(AC(34));
    const user = userEvent.setup();
    fetchDocsMock.mockResolvedValue(demoSet());

    render(
      <MemoryRouter>
        <SpecList />
      </MemoryRouter>,
    );

    await screen.findByText('Demo draft');
    // The draft card's control offers the next phase ("Specify" is plan's display name).
    const advance = screen.getByTestId('demo-advance-control');
    expect(advance).toHaveTextContent('Specify');

    await user.click(advance);

    // The pointer bumped to 'plan': only the plan demo shows now, draft is gone.
    await screen.findByText('Demo plan');
    expect(screen.queryByText('Demo draft')).not.toBeInTheDocument();
    expect(screen.queryByText('Demo build')).not.toBeInTheDocument();
    // Persisted to localStorage under the tenant-scoped key.
    expect(window.localStorage.getItem('handhold-reveal:alice/personal')).toBe('plan');
  });

  it('ac-34: at the done phase the control becomes Reset, wired to the reset action', async () => {
    tagAc(AC(34));
    const user = userEvent.setup();
    fetchDocsMock.mockResolvedValue(demoSet());
    resetHandholdDemoMock.mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    // Pre-seed the pointer at 'done' so the revealed demo is the terminal one.
    window.localStorage.setItem('handhold-reveal:alice/personal', 'done');

    render(
      <MemoryRouter>
        <SpecList />
      </MemoryRouter>,
    );

    // The done demo lives in the Done rail (auto-visible while it's the revealed
    // card via the board's reset, but here the rail is collapsed by default —
    // the board header Reset is the always-visible terminal action). Assert the
    // done demo is the only revealed card.
    await screen.findByText('Demo done');
    expect(screen.queryByText('Demo draft')).not.toBeInTheDocument();
    expect(screen.queryByText('Demo plan')).not.toBeInTheDocument();

    // The board header's Reset button is the always-available terminal action;
    // clicking it re-seeds AND clears the reveal pointer back to 'draft'.
    await user.click(screen.getByTestId('reset-demo-button'));
    await waitFor(() => expect(resetHandholdDemoMock).toHaveBeenCalledWith('alice', 'personal'));
    await waitFor(() =>
      expect(window.localStorage.getItem('handhold-reveal:alice/personal')).toBe('draft'),
    );
    confirmSpy.mockRestore();
  });

  it('ac-33/ac-34: board Reset clears the pointer → draft-only is restored', async () => {
    tagAc(AC(33));
    tagAc(AC(34));
    const user = userEvent.setup();
    fetchDocsMock.mockResolvedValue(demoSet());
    resetHandholdDemoMock.mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    // Pointer advanced to 'build' before the reset.
    window.localStorage.setItem('handhold-reveal:alice/personal', 'build');

    render(
      <MemoryRouter>
        <SpecList />
      </MemoryRouter>,
    );

    // Build demo is the only one revealed pre-reset.
    await screen.findByText('Demo build');
    expect(screen.queryByText('Demo draft')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('reset-demo-button'));

    // Reset snaps the pointer to draft → only the draft demo shows again.
    await screen.findByText('Demo draft');
    await waitFor(() => expect(screen.queryByText('Demo build')).not.toBeInTheDocument());
    expect(window.localStorage.getItem('handhold-reveal:alice/personal')).toBe('draft');
    confirmSpy.mockRestore();
  });
});
