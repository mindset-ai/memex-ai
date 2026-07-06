// spec-418 t-6 — the curation dialogs + UX state set on the Manage-tags surface.
// RTL/jsdom. Each `it` tags the AC it proves. The api client fns and the live
// SSE subscription (useDocChangeStream) are mocked; the dialogs' own logic (block
// pre-checks, focus trap, optimistic update, revert) is exercised through the
// rendered surface.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import { ManageTags } from './ManageTags';
import type { TagWithCount } from '../api/docs';

const AC = 'mindset-prod/memex-building-itself/specs/spec-418/acs';

const fetchWithCountsMock = vi.fn();
const createMock = vi.fn();
const renameMock = vi.fn();
const deleteMock = vi.fn();
vi.mock('../api/docs', async () => {
  const actual = await vi.importActual<typeof import('../api/docs')>('../api/docs');
  return {
    ...actual,
    fetchMemexTagsWithCounts: (...a: unknown[]) => fetchWithCountsMock(...a),
    createCatalogueTag: (...a: unknown[]) => createMock(...a),
    renameCatalogueTag: (...a: unknown[]) => renameMock(...a),
    deleteCatalogueTag: (...a: unknown[]) => deleteMock(...a),
  };
});

// Capture the surface's live-refresh subscription (docId, callback) without a real
// SSE fetch. The 200ms debounce/coalescing lives in the hook and is proven in
// hooks/useDocChangeStream.test.tsx — here we assert the surface WIRES it correctly.
const docStreamMock = vi.fn();
vi.mock('../hooks/useDocChangeStream', () => ({
  useDocChangeStream: (docId: string | null, cb: () => void) => docStreamMock(docId, cb),
}));

// PageHeader reaches into AuthContext for the breadcrumb — stub it so the page
// renders standalone (same shape as the t-5 suite).
vi.mock('../components/PageHeader', () => ({
  PageHeader: ({ title, actions }: { title: string; actions?: React.ReactNode }) => (
    <div>
      <h1>{title}</h1>
      {actions}
    </div>
  ),
}));

function tag(overrides: Partial<TagWithCount> = {}): TagWithCount {
  return {
    id: `${overrides.scope ?? 'flat'}-${overrides.value ?? 'x'}`,
    memexId: 'm1',
    scope: null,
    value: 'x',
    createdAt: '2026-01-01T00:00:00Z',
    assignedCount: 0,
    ...overrides,
  };
}

const CATALOGUE: TagWithCount[] = [
  tag({ scope: 'priority', value: 'high', assignedCount: 3 }),
  tag({ scope: 'priority', value: 'low', assignedCount: 1 }),
  tag({ scope: 'area', value: 'mcp', assignedCount: 2 }),
  tag({ scope: null, value: 'bug', assignedCount: 5 }),
  tag({ scope: null, value: 'api', assignedCount: 0 }),
];

function renderPage() {
  return render(
    <MemoryRouter>
      <ManageTags />
    </MemoryRouter>,
  );
}

// A promise we resolve/reject BY HAND, so a mutation mock can stay PENDING while we
// assert the optimistic intermediate state — the thing a naive mutate-on-success
// impl can never produce. This is what lets these tests distinguish real optimism
// (list changes before the server answers) from a hollow success-only update.
function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchWithCountsMock.mockResolvedValue(CATALOGUE);
});

// ── ac-27: New tag opens the Create dialog; confirming mints a tag ────────────
describe('Create dialog (ac-27)', () => {
  it('opens on "New tag", calls createCatalogueTag, and the new tag appears optimistically', async () => {
    tagAc(`${AC}/ac-27`);
    const user = userEvent.setup();
    createMock.mockResolvedValue(tag({ scope: 'area', value: 'ui' }));
    renderPage();
    await screen.findAllByTestId('tag-chip');

    await user.click(screen.getByTestId('manage-tags-new'));
    expect(screen.getByTestId('tag-create-dialog')).toBeInTheDocument();

    await user.type(screen.getByTestId('tag-dialog-input'), 'area::ui');
    await user.click(screen.getByTestId('tag-dialog-confirm'));

    expect(createMock).toHaveBeenCalledWith({ scope: 'area', value: 'ui' });
    // Optimistic (ac-36): the new tag is on the list immediately after success.
    await waitFor(() =>
      expect(
        screen.getAllByTestId('tag-chip').some((c) => c.textContent?.includes('ui')),
      ).toBe(true),
    );
  });
});

// ── ac-29: Create is blocked ONLY by the duplicate-name guard ─────────────────
describe('Create duplicate guard (ac-29)', () => {
  it('shows the duplicate block + disables confirm; no scope-exclusivity path exists', async () => {
    tagAc(`${AC}/ac-29`);
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByTestId('tag-chip');

    await user.click(screen.getByTestId('manage-tags-new'));
    // priority::high already exists — a scoped duplicate.
    await user.type(screen.getByTestId('tag-dialog-input'), 'priority::high');

    const block = screen.getByTestId('tag-dialog-block');
    expect(block).toHaveTextContent(/already exists/i);
    // The confirm is disabled by the duplicate block.
    expect(screen.getByTestId('tag-dialog-confirm')).toBeDisabled();

    // The block is the DUPLICATE reason — NEVER a per-scope exclusivity block.
    expect(block).not.toHaveTextContent(/two .* values/i);
    expect(block).not.toHaveTextContent(/scope would/i);

    // Clicking the disabled confirm does nothing — no create attempt reaches the server.
    await user.click(screen.getByTestId('tag-dialog-confirm'));
    expect(createMock).not.toHaveBeenCalled();
  });
});

// ── ac-24: dialogs carry NO descriptive sub-header ───────────────────────────
describe('No descriptive dialog sub-headers (ac-24)', () => {
  it('the rename dialog renders no descriptive paragraph until a block reason applies', async () => {
    tagAc(`${AC}/ac-24`);
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByTestId('tag-chip');

    await user.click(screen.getAllByTestId('tag-rename')[0]);
    const dialog = screen.getByTestId('tag-rename-dialog');
    // Neutral state: no paragraph text at all — no descriptive sub-header.
    expect(dialog.querySelectorAll('p')).toHaveLength(0);

    // Editing to an existing name surfaces ONLY the inline block reason.
    const input = within(dialog).getByTestId('tag-dialog-input');
    await user.clear(input);
    await user.type(input, 'priority::low');
    const ps = Array.from(dialog.querySelectorAll('p'));
    expect(ps).toHaveLength(1);
    expect(ps[0]).toHaveAttribute('data-testid', 'tag-dialog-block');
  });

  it('the delete dialog shows only load-bearing text (blast radius), no sub-header', async () => {
    tagAc(`${AC}/ac-24`);
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByTestId('tag-chip');

    // "bug" is on 5 Specs — the confirm names the blast radius.
    await user.click(screen.getByRole('button', { name: 'Delete bug' }));
    const dialog = screen.getByTestId('tag-delete-dialog');
    expect(within(dialog).getByTestId('tag-delete-blast')).toHaveTextContent(
      /Still in use on 5 Specs/i,
    );
    // Every paragraph in the dialog is load-bearing (carries a testid) — no stray
    // descriptive sub-header slipped in.
    for (const p of Array.from(dialog.querySelectorAll('p'))) {
      expect(p).toHaveAttribute('data-testid');
    }
  });

  it('a 0-Spec delete drops the warning and reads simply "Delete"', async () => {
    tagAc(`${AC}/ac-24`);
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByTestId('tag-chip');

    // "api" is on 0 Specs.
    await user.click(screen.getByRole('button', { name: 'Delete api' }));
    const dialog = screen.getByTestId('tag-delete-dialog');
    expect(within(dialog).queryByTestId('tag-delete-blast')).not.toBeInTheDocument();
    expect(within(dialog).getByTestId('tag-dialog-confirm')).toHaveTextContent(/^Delete$/);
  });
});

// ── ac-34: states — empty / loading / server-error / keyboard ────────────────
describe('UX states + keyboard (ac-34)', () => {
  it('renders the empty state with a create-a-Spec link', async () => {
    tagAc(`${AC}/ac-34`);
    fetchWithCountsMock.mockResolvedValue([]);
    renderPage();

    const empty = await screen.findByTestId('manage-tags-empty');
    expect(empty).toBeInTheDocument();
    expect(screen.getByTestId('manage-tags-empty-cta')).toBeInTheDocument();
  });

  it('renders the loading skeleton before data arrives', () => {
    tagAc(`${AC}/ac-34`);
    fetchWithCountsMock.mockReturnValue(new Promise(() => {})); // never resolves
    renderPage();
    expect(screen.getByTestId('manage-tags-skeleton')).toBeInTheDocument();
  });

  it('a server-error keeps the dialog open, shows the reason, and reverts the optimistic change', async () => {
    tagAc(`${AC}/ac-34`);
    const user = userEvent.setup();
    deleteMock.mockRejectedValue(new Error('Row-level security prevented this delete'));
    renderPage();
    await screen.findAllByTestId('tag-chip');

    await user.click(screen.getByRole('button', { name: 'Delete bug' }));
    await user.click(screen.getByTestId('tag-dialog-confirm'));

    // Dialog stays open with the server's plain reason inline.
    await waitFor(() =>
      expect(screen.getByTestId('tag-delete-dialog')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('tag-dialog-block')).toHaveTextContent(
      /Row-level security prevented this delete/,
    );
    // Reverted: the "bug" row is back on the list.
    expect(
      screen.getAllByTestId('tag-chip').some((c) => c.textContent?.includes('bug')),
    ).toBe(true);
  });

  it('is keyboard-operable: Enter invokes a row action, dialog traps focus, Escape closes + returns focus', async () => {
    tagAc(`${AC}/ac-34`);
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByTestId('tag-chip');

    // Focus a Rename button and invoke it by keyboard (Enter).
    const renameBtn = screen.getByRole('button', { name: 'Rename bug' });
    renameBtn.focus();
    expect(renameBtn).toHaveFocus();
    await user.keyboard('{Enter}');

    const dialog = screen.getByTestId('tag-rename-dialog');
    // Focus moved INTO the dialog.
    expect(dialog.contains(document.activeElement)).toBe(true);

    // Focus trap: repeated Tab never escapes the dialog.
    for (let i = 0; i < 6; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }

    // Escape closes and returns focus to the trigger.
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByTestId('tag-rename-dialog')).not.toBeInTheDocument(),
    );
    expect(renameBtn).toHaveFocus();
  });
});

// ── ac-36: optimistic update, named post-delete toast, revert-with-reason ─────
describe('Optimistic update + named toast (ac-36)', () => {
  it('removes the row optimistically and raises a NAMED post-delete toast', async () => {
    tagAc(`${AC}/ac-36`);
    const user = userEvent.setup();
    deleteMock.mockResolvedValue({ removed: 1, affectedDocIds: ['d1', 'd2', 'd3', 'd4', 'd5'] });
    renderPage();
    await screen.findAllByTestId('tag-chip');

    await user.click(screen.getByRole('button', { name: 'Delete bug' }));
    await user.click(screen.getByTestId('tag-dialog-confirm'));

    // Named confirmation names the exact tag + its blast radius.
    await waitFor(() =>
      expect(screen.getByTestId('manage-tags-toast')).toHaveTextContent(
        "Deleted 'bug' from 5 Specs",
      ),
    );
    // The row is gone.
    expect(
      screen.getAllByTestId('tag-chip').some((c) => c.textContent === 'bug'),
    ).toBe(false);
  });
});

// ── ac-36: optimistic INTERMEDIATE state proven with a pending mutation ───────
// Each mutation mock stays PENDING (a deferred promise). We assert the list has
// ALREADY changed while the server has not answered — the discriminator a naive
// non-optimistic (mutate-then-refetch-on-success) impl cannot pass — then resolve
// to prove the swap, and separately reject to prove revert-to-snapshot WITH reason.
describe('Optimistic intermediate state, all three handlers (ac-36)', () => {
  it('create: adds the row while pending, then swaps in the server row on resolve', async () => {
    tagAc(`${AC}/ac-36`);
    const user = userEvent.setup();
    const d = deferred<TagWithCount>();
    createMock.mockReturnValue(d.promise);
    renderPage();
    await screen.findAllByTestId('tag-chip');

    await user.click(screen.getByTestId('manage-tags-new'));
    await user.type(screen.getByTestId('tag-dialog-input'), 'area::ui');
    await user.click(screen.getByTestId('tag-dialog-confirm'));

    // PENDING: the optimistic row is on the list BEFORE the server answers.
    await waitFor(() =>
      expect(
        screen.getAllByTestId('tag-chip').some((c) => c.textContent?.includes('ui')),
      ).toBe(true),
    );
    expect(createMock).toHaveBeenCalledWith({ scope: 'area', value: 'ui' });
    // Dialog is still open — the mutation is genuinely in flight.
    expect(screen.getByTestId('tag-create-dialog')).toBeInTheDocument();

    // RESOLVE: placeholder swaps for the real row and the dialog closes.
    d.resolve(tag({ id: 'real-ui', scope: 'area', value: 'ui' }));
    await waitFor(() =>
      expect(screen.queryByTestId('tag-create-dialog')).not.toBeInTheDocument(),
    );
    expect(
      screen.getAllByTestId('tag-chip').some((c) => c.textContent?.includes('ui')),
    ).toBe(true);
  });

  it('create: reverts the optimistic add and shows the reason when it rejects', async () => {
    tagAc(`${AC}/ac-36`);
    const user = userEvent.setup();
    const d = deferred<TagWithCount>();
    createMock.mockReturnValue(d.promise);
    renderPage();
    await screen.findAllByTestId('tag-chip');

    await user.click(screen.getByTestId('manage-tags-new'));
    await user.type(screen.getByTestId('tag-dialog-input'), 'area::ui');
    await user.click(screen.getByTestId('tag-dialog-confirm'));

    // PENDING: optimistic row present.
    await waitFor(() =>
      expect(
        screen.getAllByTestId('tag-chip').some((c) => c.textContent?.includes('ui')),
      ).toBe(true),
    );

    // REJECT: revert removes the optimistic row AND the dialog surfaces the reason.
    d.reject(new Error('A tag named "area::ui" already exists'));
    await waitFor(() =>
      expect(screen.getByTestId('tag-dialog-block')).toHaveTextContent(
        /A tag named "area::ui" already exists/,
      ),
    );
    expect(screen.getByTestId('tag-create-dialog')).toBeInTheDocument();
    expect(
      screen.getAllByTestId('tag-chip').some((c) => c.textContent?.includes('ui')),
    ).toBe(false);
  });

  it('rename: updates the row while pending, then keeps the new name on resolve', async () => {
    tagAc(`${AC}/ac-36`);
    const user = userEvent.setup();
    const d = deferred();
    renameMock.mockReturnValue(d.promise);
    renderPage();
    await screen.findAllByTestId('tag-chip');

    await user.click(screen.getByRole('button', { name: 'Rename bug' }));
    const dialog = screen.getByTestId('tag-rename-dialog');
    const input = within(dialog).getByTestId('tag-dialog-input');
    await user.clear(input);
    await user.type(input, 'zebra');
    await user.click(within(dialog).getByTestId('tag-dialog-confirm'));

    // PENDING: 'zebra' is on the list and 'bug' is gone BEFORE the server answers.
    await waitFor(() =>
      expect(screen.getAllByTestId('tag-chip').some((c) => c.textContent === 'zebra')).toBe(true),
    );
    expect(screen.getAllByTestId('tag-chip').some((c) => c.textContent === 'bug')).toBe(false);
    expect(renameMock).toHaveBeenCalledWith('flat-bug', { scope: null, value: 'zebra' });
    expect(screen.getByTestId('tag-rename-dialog')).toBeInTheDocument();

    // RESOLVE: the new name persists and the dialog closes.
    d.resolve({ scope: null, value: 'zebra' });
    await waitFor(() =>
      expect(screen.queryByTestId('tag-rename-dialog')).not.toBeInTheDocument(),
    );
    expect(screen.getAllByTestId('tag-chip').some((c) => c.textContent === 'zebra')).toBe(true);
  });

  it('rename: reverts to the old name and shows the reason when it rejects', async () => {
    tagAc(`${AC}/ac-36`);
    const user = userEvent.setup();
    const d = deferred();
    renameMock.mockReturnValue(d.promise);
    renderPage();
    await screen.findAllByTestId('tag-chip');

    await user.click(screen.getByRole('button', { name: 'Rename bug' }));
    const dialog = screen.getByTestId('tag-rename-dialog');
    const input = within(dialog).getByTestId('tag-dialog-input');
    await user.clear(input);
    await user.type(input, 'zebra');
    await user.click(within(dialog).getByTestId('tag-dialog-confirm'));

    // PENDING: optimistic rename applied.
    await waitFor(() =>
      expect(screen.getAllByTestId('tag-chip').some((c) => c.textContent === 'zebra')).toBe(true),
    );

    // REJECT: the scope-exclusivity reason surfaces AND the row reverts to 'bug'.
    d.reject(new Error('That scope would leave a Spec holding two values'));
    await waitFor(() =>
      expect(within(dialog).getByTestId('tag-dialog-block')).toHaveTextContent(
        /two values/,
      ),
    );
    expect(screen.getByTestId('tag-rename-dialog')).toBeInTheDocument();
    expect(screen.getAllByTestId('tag-chip').some((c) => c.textContent === 'bug')).toBe(true);
    expect(screen.getAllByTestId('tag-chip').some((c) => c.textContent === 'zebra')).toBe(false);
  });

  it('delete: removes the row while pending (no toast yet), then raises the toast on resolve', async () => {
    tagAc(`${AC}/ac-36`);
    const user = userEvent.setup();
    const d = deferred();
    deleteMock.mockReturnValue(d.promise);
    renderPage();
    await screen.findAllByTestId('tag-chip');

    await user.click(screen.getByRole('button', { name: 'Delete bug' }));
    await user.click(screen.getByTestId('tag-dialog-confirm'));

    // PENDING: 'bug' is already gone, but the confirmation toast has NOT fired —
    // proving the removal is optimistic, not a post-success rerender.
    await waitFor(() =>
      expect(screen.getAllByTestId('tag-chip').some((c) => c.textContent === 'bug')).toBe(false),
    );
    expect(screen.queryByTestId('manage-tags-toast')).not.toBeInTheDocument();
    expect(screen.getByTestId('tag-delete-dialog')).toBeInTheDocument();

    // RESOLVE: the named post-delete toast fires and the dialog closes.
    d.resolve({ removed: 1, affectedDocIds: [] });
    await waitFor(() =>
      expect(screen.getByTestId('manage-tags-toast')).toHaveTextContent(
        "Deleted 'bug' from 5 Specs",
      ),
    );
    expect(screen.queryByTestId('tag-delete-dialog')).not.toBeInTheDocument();
  });

  it('delete: restores the row while pending-then-rejected and shows the reason', async () => {
    tagAc(`${AC}/ac-36`);
    const user = userEvent.setup();
    const d = deferred();
    deleteMock.mockReturnValue(d.promise);
    renderPage();
    await screen.findAllByTestId('tag-chip');

    await user.click(screen.getByRole('button', { name: 'Delete bug' }));
    await user.click(screen.getByTestId('tag-dialog-confirm'));

    // PENDING: optimistic removal.
    await waitFor(() =>
      expect(screen.getAllByTestId('tag-chip').some((c) => c.textContent === 'bug')).toBe(false),
    );

    // REJECT: the row comes back AND the reason shows; no toast (nothing was deleted).
    d.reject(new Error('Row-level security prevented this delete'));
    await waitFor(() =>
      expect(screen.getByTestId('tag-dialog-block')).toHaveTextContent(
        /Row-level security prevented this delete/,
      ),
    );
    expect(screen.getByTestId('tag-delete-dialog')).toBeInTheDocument();
    expect(screen.getAllByTestId('tag-chip').some((c) => c.textContent === 'bug')).toBe(true);
    expect(screen.queryByTestId('manage-tags-toast')).not.toBeInTheDocument();
  });
});

// ── ac-7 / ac-17: live board/surface refresh via one coalesced subscription ───
describe('Live refresh subscription (ac-7, ac-17)', () => {
  it('subscribes with useDocChangeStream(null, refetch) — a single coalesced callback — and refetches when it fires', async () => {
    tagAc(`${AC}/ac-7`);
    tagAc(`${AC}/ac-17`);
    renderPage();
    await screen.findAllByTestId('tag-chip');

    // Every subscription is the Memex-wide stream (docId null).
    expect(docStreamMock.mock.calls.length).toBeGreaterThan(0);
    expect(docStreamMock.mock.calls.every((c) => c[0] === null)).toBe(true);

    // The surface passes ONE stable callback across renders — it relies on the
    // hook's 200ms debounce to coalesce a fan-out burst, rather than subscribing
    // per event / refetching per event.
    const callbacks = docStreamMock.mock.calls.map((c) => c[1]);
    expect(new Set(callbacks).size).toBe(1);

    // Firing that coalesced callback triggers exactly one refetch.
    fetchWithCountsMock.mockClear();
    const refetch = callbacks[0] as () => void;
    refetch();
    await waitFor(() => expect(fetchWithCountsMock).toHaveBeenCalledTimes(1));
  });
});
