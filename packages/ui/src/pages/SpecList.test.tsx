import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { SpecList } from './SpecList';
import type { DocSummary } from '../api/types';
import type { SessionPayload } from '../api/client';
import { tagAc } from '@memex-ai-ac/vitest';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-118/acs/ac-${n}`;
// spec-147 t-1: the pause feature-hide ACs live in spec-147, not spec-118.
const AC_147 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-147/acs/ac-${n}`;

// Surfaces the current location.search so URL-reflection assertions can read it.
function LocationDisplay() {
  const loc = useLocation();
  return <div data-testid="location-search">{loc.search}</div>;
}

// `useDocChangeStream` opens a real EventSource — stub so the test stays
// hermetic. The test only cares that the specs render once.
vi.mock('../hooks/useDocChangeStream', () => ({
  useDocChangeStream: () => {},
}));

const fetchDocsMock = vi.fn();
vi.mock('../api/client', () => ({
  fetchDocs: (...args: unknown[]) => fetchDocsMock(...args),
  updateDocStatus: vi.fn(),
  archiveDoc: vi.fn(),
  pauseDoc: vi.fn(),
  unpauseDoc: vi.fn(),
}));

// NewSpecModal pulls in heavy chat plumbing — stub so the test stays focused
// on the list rendering behavior.
vi.mock('../components/NewSpecModal', () => ({
  NewSpecModal: () => null,
}));

vi.mock('../components/ShareModal', () => ({
  ShareModal: () => null,
}));

vi.mock('../components/RenameSpecDialog', () => ({
  RenameSpecDialog: () => null,
}));

vi.mock('../components/MoveSpecDialog', () => ({
  MoveSpecDialog: () => null,
}));

// AuthContext is consulted to decide whether to render CreateOrgBanner and (via
// useIsFeatureHidden) whether the pause feature is hidden. `mockSession` is a
// mutable holder so individual tests can drive the session's `hiddenFeatures`
// without re-mocking the module; it defaults to null (no session → nothing
// hidden), matching the original behaviour every existing test relies on.
// `vi.mock` is hoisted, so the holder is declared inside `vi.hoisted` and reset
// per-test in `beforeEach`.
const { mockSession } = vi.hoisted(() => ({
  mockSession: { value: null as SessionPayload | null },
}));
vi.mock('../components/AuthContext', () => ({
  useAuth: () => ({ session: mockSession.value }),
}));

// useMemexAccess gates the per-card SpecMenu (which hosts the Pause/Unpause
// item) behind write access. It normally derives `canWrite` from the tenant URL
// in window.location, which jsdom pins to "/" — so the menu would never render
// here. A mutable holder lets the spec-147 menu test grant write access without
// disturbing the other suites (default false === today's anonymous behaviour).
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

// CreateOrgBanner is hidden by the showPersonalBanner guard in these tests
// (session=null), but the stub keeps the import edge clean.
vi.mock('../components/CreateOrgBanner', () => ({
  CreateOrgBanner: () => null,
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

const SHOW_PAUSED_KEY = 'memex.spec-list.show-paused';

// spec-147 t-1: a minimal signed-in session carrying the given hidden-feature
// slugs. SpecList reads `memberships`/`currentMemexId` (CreateOrgBanner gate)
// and `hiddenFeatures` (pause feature-hide) off the session; the rest satisfy
// the type. Empty `memberships` keeps the personal banner suppressed.
function sessionWith(hiddenFeatures: string[]): SessionPayload {
  return {
    user: {
      id: 'u-1',
      email: 'pause@example.com',
      name: 'Pause Tester',
      status: 'active',
      emailVerified: true,
    },
    memberships: [],
    currentMemexId: null,
    currentRole: null,
    needsOnboarding: false,
    hiddenFeatures,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default to no session → nothing hidden, i.e. today's behaviour.
  mockSession.value = null;
  // Default read-only → matches the pre-existing anonymous-session suites.
  mockCanWrite.value = false;
  // Tests assert localStorage persistence — wipe between cases so prior state
  // doesn't leak into the "default off" assertions.
  window.localStorage.removeItem(SHOW_PAUSED_KEY);
});

describe('SpecList', () => {
  it('queries the server with type=spec', async () => {
    fetchDocsMock.mockResolvedValueOnce([]);

    render(
      <MemoryRouter>
        <SpecList />
      </MemoryRouter>
    );

    await waitFor(() => {
      // SpecList opts into the acHealth roll-up (b-66), the assignees roll-up
      // (spec-118 ac-18), AND the tags roll-up (spec-136 t-4) via the include
      // flags so the board renders the per-Spec health accent, assignee avatars,
      // and tag chips in one round-trip.
      expect(fetchDocsMock).toHaveBeenCalledWith('spec', {
        include: ['acHealth', 'assignees', 'tags'],
      });
    });
  });

  // User-reported: with the Done column expanded the board overflowed the
  // viewport and clipped — no way to scroll right. The board row must scroll
  // horizontally, and columns need a floor width (flex min-width:auto would
  // otherwise let card content dictate an unshrinkable minimum).
  it('the board scrolls horizontally and columns carry a min width', async () => {
    fetchDocsMock.mockResolvedValueOnce([]);

    render(
      <MemoryRouter>
        <SpecList />
      </MemoryRouter>
    );

    const board = await screen.findByTestId('kanban-board');
    expect(board.className).toContain('overflow-x-auto');
    // Every expanded column (the ACTIVE_COLUMNS) carries the min-width floor.
    const draftColumn = screen.getByText('Draft').closest('div[class*="rounded-lg"]');
    expect(draftColumn?.className).toContain('min-w-[14rem]');
  });

  it('renders spec titles in the appropriate kanban column', async () => {
    fetchDocsMock.mockResolvedValueOnce([
      spec({
        id: 's-1',
        title: 'Auth migration',
        handle: 'doc-1',
        status: 'draft',
      }),
      spec({
        id: 's-2',
        title: 'Deploy SaaS edition',
        handle: 'doc-2',
        status: 'review',
      }),
    ]);

    render(
      <MemoryRouter>
        <SpecList />
      </MemoryRouter>
    );

    expect(await screen.findByText('Auth migration')).toBeInTheDocument();
    expect(screen.getByText('Deploy SaaS edition')).toBeInTheDocument();
  });

  it('shows "Promoted from <parent>" lineage when parentDocId is set', async () => {
    fetchDocsMock.mockResolvedValueOnce([
      spec({ id: 's-1', title: 'Parent spec', handle: 'doc-1' }),
      spec({
        id: 's-2',
        title: 'Child spec',
        handle: 'doc-2',
        parentDocId: 's-1',
      }),
    ]);

    render(
      <MemoryRouter>
        <SpecList />
      </MemoryRouter>
    );

    await screen.findByText('Child spec');

    const parentLabel = screen.getByTestId('spec-parent');
    expect(parentLabel).toHaveTextContent('Promoted from Parent spec');
  });

  it('falls back to the parent UUID when the parent is not in the same list', async () => {
    fetchDocsMock.mockResolvedValueOnce([
      spec({
        id: 's-2',
        title: 'Lone child',
        handle: 'doc-2',
        parentDocId: 'orphan-uuid',
      }),
    ]);

    render(
      <MemoryRouter>
        <SpecList />
      </MemoryRouter>
    );

    const parentLabel = await screen.findByTestId('spec-parent');
    expect(parentLabel).toHaveTextContent('Promoted from orphan-uuid');
  });

  // doc-12 t-13: paused/archived filtering. Default view hides both; "Show paused"
  // toggle re-includes paused (with a dimmed treatment + Paused pill); archived
  // never renders here (no UI for it in this iteration).
  describe('paused / archived filtering', () => {
    it('excludes paused and archived specs by default', async () => {
      fetchDocsMock.mockResolvedValueOnce([
        spec({ id: 's-1', title: 'Active spec', handle: 'doc-1' }),
        spec({
          id: 's-2',
          title: 'Paused spec',
          handle: 'doc-2',
          pausedAt: '2026-05-01T00:00:00Z',
        }),
        spec({
          id: 's-3',
          title: 'Archived spec',
          handle: 'doc-3',
          archivedAt: '2026-05-01T00:00:00Z',
        }),
      ]);

      render(
        <MemoryRouter>
          <SpecList />
        </MemoryRouter>
      );

      expect(await screen.findByText('Active spec')).toBeInTheDocument();
      expect(screen.queryByText('Paused spec')).not.toBeInTheDocument();
      expect(screen.queryByText('Archived spec')).not.toBeInTheDocument();
    });

    it('includes paused specs when "Show paused" is toggled on', async () => {
      const user = userEvent.setup();
      fetchDocsMock.mockResolvedValueOnce([
        spec({ id: 's-1', title: 'Active spec', handle: 'doc-1' }),
        spec({
          id: 's-2',
          title: 'Paused spec',
          handle: 'doc-2',
          pausedAt: '2026-05-01T00:00:00Z',
        }),
        spec({
          id: 's-3',
          title: 'Archived spec',
          handle: 'doc-3',
          archivedAt: '2026-05-01T00:00:00Z',
        }),
      ]);

      render(
        <MemoryRouter>
          <SpecList />
        </MemoryRouter>
      );

      // Wait for initial render before flipping the toggle.
      await screen.findByText('Active spec');
      expect(screen.queryByText('Paused spec')).not.toBeInTheDocument();

      const toggle = screen.getByRole('checkbox', { name: /show paused/i });
      await user.click(toggle);

      expect(screen.getByText('Paused spec')).toBeInTheDocument();
      // Archived is still hidden — the toggle only controls paused per t-13.
      expect(screen.queryByText('Archived spec')).not.toBeInTheDocument();
    });

    it('marks shown paused specs with a "Paused" pill', async () => {
      const user = userEvent.setup();
      fetchDocsMock.mockResolvedValueOnce([
        spec({
          id: 's-2',
          title: 'Paused spec',
          handle: 'doc-2',
          pausedAt: '2026-05-01T00:00:00Z',
        }),
      ]);

      render(
        <MemoryRouter>
          <SpecList />
        </MemoryRouter>
      );

      const toggle = await screen.findByRole('checkbox', { name: /show paused/i });
      await user.click(toggle);

      const pill = await screen.findByTestId('spec-paused-pill');
      expect(pill).toHaveTextContent(/paused/i);
    });

    it('persists the "Show paused" toggle to localStorage', async () => {
      const user = userEvent.setup();
      fetchDocsMock.mockResolvedValueOnce([
        spec({ id: 's-1', title: 'Active spec', handle: 'doc-1' }),
      ]);

      render(
        <MemoryRouter>
          <SpecList />
        </MemoryRouter>
      );

      const toggle = await screen.findByRole('checkbox', { name: /show paused/i });
      // Component writes the current state to storage on mount as a side-effect
      // of the persistence effect, so the meaningful assertion is "click flips
      // the value", not "value starts unset".
      expect(window.localStorage.getItem(SHOW_PAUSED_KEY)).toBe('false');

      await user.click(toggle);
      expect(window.localStorage.getItem(SHOW_PAUSED_KEY)).toBe('true');

      await user.click(toggle);
      expect(window.localStorage.getItem(SHOW_PAUSED_KEY)).toBe('false');
    });

    it('reads the persisted toggle on mount', async () => {
      window.localStorage.setItem(SHOW_PAUSED_KEY, 'true');
      fetchDocsMock.mockResolvedValueOnce([
        spec({ id: 's-1', title: 'Active spec', handle: 'doc-1' }),
        spec({
          id: 's-2',
          title: 'Paused spec',
          handle: 'doc-2',
          pausedAt: '2026-05-01T00:00:00Z',
        }),
      ]);

      render(
        <MemoryRouter>
          <SpecList />
        </MemoryRouter>
      );

      // Paused spec visible on first paint — no toggle click required.
      expect(await screen.findByText('Paused spec')).toBeInTheDocument();
      const toggle = screen.getByRole('checkbox', { name: /show paused/i });
      expect(toggle).toBeChecked();
    });
  });
});

// spec-147 t-1 (dec-1 / Option A): when 'spec-pause' is in the session's
// hiddenFeatures the pause feature disappears from this board — the "Show
// paused" header toggle and the per-card Pause/Unpause menu item are gone, and
// the board STOPS dropping already-paused Specs (so hiding the feature never
// silently loses in-flight work). ac-11 pins the no-regression baseline.
describe('SpecList pause feature-hide (spec-147)', () => {
  // Opens the per-card actions menu and returns the live <menu> element. The
  // SpecMenu trigger is keyed off the card title and only renders under write
  // access (mockCanWrite), so callers grant that first.
  async function openCardMenu(title: string) {
    const user = userEvent.setup();
    const trigger = await screen.findByRole('button', { name: `Actions for ${title}` });
    await user.click(trigger);
    return screen.getByRole('menu');
  }

  it('ac-7: does NOT render the "Show paused" toggle when spec-pause is hidden', async () => {
    tagAc(AC_147(7));
    mockSession.value = sessionWith(['spec-pause']);
    fetchDocsMock.mockResolvedValueOnce([
      spec({ id: 's-1', title: 'Active spec', handle: 'doc-1' }),
    ]);

    render(
      <MemoryRouter>
        <SpecList />
      </MemoryRouter>,
    );

    await screen.findByText('Active spec');
    expect(screen.queryByRole('checkbox', { name: /show paused/i })).not.toBeInTheDocument();
  });

  it('ac-8: omits the Pause/Unpause menu item (no orphaned separator) when hidden', async () => {
    tagAc(AC_147(8));
    mockSession.value = sessionWith(['spec-pause']);
    mockCanWrite.value = true; // SpecMenu renders only under write access.
    fetchDocsMock.mockResolvedValueOnce([
      spec({ id: 's-1', title: 'Active spec', handle: 'doc-1' }),
    ]);

    render(
      <MemoryRouter>
        <SpecList />
      </MemoryRouter>,
    );

    const menu = await openCardMenu('Active spec');
    const labels = within(menu)
      .getAllByRole('menuitem')
      .map((b) => b.textContent);
    // Pause/Unpause gone; the remaining items keep their order.
    expect(labels).toEqual(['Rename', 'Share', 'Move to another memex', 'Archive']);
    expect(within(menu).queryByRole('menuitem', { name: /^(Pause|Unpause)$/ })).toBeNull();

    // No orphaned / leading separator: a divider never precedes the first item,
    // and the count of dividers matches the items that legitimately carry one
    // (Move-to-another-memex inherits Pause's divider; Archive keeps its own).
    const firstItem = within(menu).getByRole('menuitem', { name: 'Rename' });
    expect(firstItem.parentElement?.querySelector('.border-t')).toBeNull();
    const dividers = menu.querySelectorAll('.border-t');
    expect(dividers).toHaveLength(2);
  });

  it('ac-9: a paused Spec STILL appears on the board when the feature is hidden', async () => {
    tagAc(AC_147(9));
    mockSession.value = sessionWith(['spec-pause']);
    // No "Show paused" toggle exists to flip, and localStorage stays default-off
    // — the Spec must show purely because the feature is hidden (Option A).
    fetchDocsMock.mockResolvedValueOnce([
      spec({ id: 's-1', title: 'Active spec', handle: 'doc-1' }),
      spec({
        id: 's-2',
        title: 'Paused spec',
        handle: 'doc-2',
        pausedAt: '2026-05-01T00:00:00Z',
      }),
    ]);

    render(
      <MemoryRouter>
        <SpecList />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Active spec')).toBeInTheDocument();
    expect(screen.getByText('Paused spec')).toBeInTheDocument();
  });

  it('ac-10: the still-shown paused Spec keeps its "Paused" badge + dimming when hidden', async () => {
    tagAc(AC_147(10));
    mockSession.value = sessionWith(['spec-pause']);
    fetchDocsMock.mockResolvedValueOnce([
      spec({
        id: 's-2',
        title: 'Paused spec',
        handle: 'doc-2',
        pausedAt: '2026-05-01T00:00:00Z',
      }),
    ]);

    render(
      <MemoryRouter>
        <SpecList />
      </MemoryRouter>,
    );

    // The card renders without flipping any toggle (there is none).
    const title = await screen.findByText('Paused spec');
    // "Paused" badge surface (the sr-only test hook mirrors the visible Badge).
    expect(screen.getByTestId('spec-paused-pill')).toHaveTextContent(/paused/i);
    // Dimmed treatment: the card link carries the opacity-60 paused class.
    const cardLink = title.closest('a');
    expect(cardLink?.className).toContain('opacity-60');
  });

  it('ac-11: with hiddenFeatures [], the toggle, menu item, and paused-filter behave as today', async () => {
    tagAc(AC_147(11));
    mockSession.value = sessionWith([]); // feature NOT hidden.
    mockCanWrite.value = true;
    const user = userEvent.setup();
    fetchDocsMock.mockResolvedValue([
      spec({ id: 's-1', title: 'Active spec', handle: 'doc-1' }),
      spec({
        id: 's-2',
        title: 'Paused spec',
        handle: 'doc-2',
        pausedAt: '2026-05-01T00:00:00Z',
      }),
    ]);

    render(
      <MemoryRouter>
        <SpecList />
      </MemoryRouter>,
    );

    // Paused-filter unchanged: paused Spec hidden by default, toggle present.
    await screen.findByText('Active spec');
    expect(screen.queryByText('Paused spec')).not.toBeInTheDocument();
    const toggle = screen.getByRole('checkbox', { name: /show paused/i });
    await user.click(toggle);
    expect(screen.getByText('Paused spec')).toBeInTheDocument();

    // Menu item present, in its original position with its own divider; the
    // following "Move to another memex" carries no divider (today's layout).
    const trigger = screen.getByRole('button', { name: 'Actions for Active spec' });
    await user.click(trigger);
    const menu = screen.getByRole('menu');
    const labels = within(menu)
      .getAllByRole('menuitem')
      .map((b) => b.textContent);
    expect(labels).toEqual(['Rename', 'Share', 'Pause', 'Move to another memex', 'Archive']);
    // Two dividers: before Pause and before Archive (unchanged from today).
    expect(menu.querySelectorAll('.border-t')).toHaveLength(2);
  });
});

describe('SpecList assignees + filter (spec-118)', () => {
  const alice = { userId: 'u1', name: 'Alice', email: 'alice@x.com' };
  const bob = { userId: 'u2', name: 'Bob', email: 'bob@x.com' };

  it('renders assignee avatar(s) on the card and an Unassigned state otherwise (ac-18)', async () => {
    tagAc(AC(18));
    fetchDocsMock.mockResolvedValueOnce([
      spec({ id: 's-1', title: 'Assigned spec', handle: 'doc-1', assignees: [alice] }),
      spec({ id: 's-2', title: 'Lonely spec', handle: 'doc-2' }),
    ]);

    render(
      <MemoryRouter>
        <SpecList />
      </MemoryRouter>,
    );

    await screen.findByText('Assigned spec');
    // The assigned card shows the assignee avatar cluster + the single assignee's name.
    const cluster = screen.getByTestId('spec-assignees');
    expect(cluster).toBeInTheDocument();
    expect(within(cluster).getByText('Alice')).toBeInTheDocument();
    // The unassigned card shows the explicit Unassigned state.
    expect(screen.getByTestId('spec-unassigned')).toBeInTheDocument();
  });

  it('a URL ?assignee=<userId> filters the board to that person (ac-19)', async () => {
    tagAc(AC(19));
    fetchDocsMock.mockResolvedValueOnce([
      spec({ id: 's-1', title: 'Alice work', handle: 'doc-1', assignees: [alice] }),
      spec({ id: 's-2', title: 'Bob work', handle: 'doc-2', assignees: [bob] }),
    ]);

    render(
      <MemoryRouter initialEntries={['/?assignee=u1']}>
        <SpecList />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Alice work')).toBeInTheDocument();
    expect(screen.queryByText('Bob work')).not.toBeInTheDocument();
  });

  it('exposes an assignee filter with All / Assigned to me / per-person options, reflected in the URL (ac-19)', async () => {
    tagAc(AC(19));
    const user = userEvent.setup();
    // Persistent (not -Once): selecting an assignee re-renders and can trigger a
    // second loadDocs; a one-shot mock would resolve undefined on the 2nd call
    // and crash in `.then`. Return the same set for every call.
    fetchDocsMock.mockResolvedValue([
      spec({ id: 's-1', title: 'Alice work', handle: 'doc-1', assignees: [alice] }),
      spec({ id: 's-2', title: 'Bob work', handle: 'doc-2', assignees: [bob] }),
    ]);

    render(
      <MemoryRouter>
        <SpecList />
        <LocationDisplay />
      </MemoryRouter>,
    );

    await screen.findByText('Alice work');
    const select = screen.getByLabelText('Filter by assignee') as HTMLSelectElement;
    // Options: All, Assigned to me, and each assigned person.
    const optionLabels = Array.from(select.options).map((o) => o.textContent);
    expect(optionLabels).toEqual(expect.arrayContaining(['All', 'Assigned to me', 'Alice', 'Bob']));

    // Selecting a person reflects into the URL and filters the board.
    await user.selectOptions(select, 'u2');
    expect(screen.getByTestId('location-search').textContent).toContain('assignee=u2');
    expect(screen.getByText('Bob work')).toBeInTheDocument();
    expect(screen.queryByText('Alice work')).not.toBeInTheDocument();
  });
});

// Placate the unused-import linter if `act` ends up unused in some refactors.
void act;

// spec-164 dec-1 / ac-13 — list views route phase names through the shared
// display-name layer: the kanban planning column reads "Specify", never "Plan".
describe('SpecList — phase display names (spec-164)', () => {
  const AC_DISPLAY = 'mindset-prod/memex-building-itself/specs/spec-164/acs/ac-13';

  it('the planning kanban column is headed "Specify" (no "Plan" heading remains)', async () => {
    tagAc(AC_DISPLAY);
    fetchDocsMock.mockResolvedValueOnce([
      spec({ id: 's-1', title: 'Auth migration', handle: 'doc-1', status: 'plan' }),
    ]);

    render(
      <MemoryRouter>
        <SpecList />
      </MemoryRouter>
    );

    expect(await screen.findByText('Auth migration')).toBeInTheDocument();
    expect(screen.getByText('Specify')).toBeInTheDocument();
    expect(screen.queryByText('Plan')).not.toBeInTheDocument();
  });
});
