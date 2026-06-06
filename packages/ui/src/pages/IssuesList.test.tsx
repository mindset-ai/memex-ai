import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import type { MemexIssue } from '../api/client';

// spec-158 t-4 — the Memex-level Issues page. ac-17 (the issue-row deep-link)
// is tagged below; the rest of the page contract (grouping, type pill, time-ago
// + hover, filter URL round-trip, scope→endpoint params) is asserted untagged.
const AC_DEEP_LINK = 'mindset-prod/memex-building-itself/specs/spec-158/acs/ac-17';

// spec-158 t-5 — the inline row actions (dec-6): Close (Resolve / Won't fix) and
// Convert to Spec (prefilled NewSpecModal carrying the Issue's promote ref).
const AC_CLOSE = 'mindset-prod/memex-building-itself/specs/spec-158/acs/ac-18';
const AC_CONVERT = 'mindset-prod/memex-building-itself/specs/spec-158/acs/ac-19';

// spec-158 scope ACs for the Issues page.
const AC_SCOPE = 'mindset-prod/memex-building-itself/specs/spec-158/acs/ac-2';
const AC_PHASE_FILTER = 'mindset-prod/memex-building-itself/specs/spec-158/acs/ac-3';
const AC_GROUPING = 'mindset-prod/memex-building-itself/specs/spec-158/acs/ac-7';
const AC_ROW_ACTIONS = 'mindset-prod/memex-building-itself/specs/spec-158/acs/ac-8';
const AC_TYPE_PILL = 'mindset-prod/memex-building-itself/specs/spec-158/acs/ac-9';

// The page's data dependencies: fetchMemexIssues (the list) + updateIssueStatusApi
// (the EXISTING resolve path the Close menu reuses). Capture both so we can assert
// the scope/phase/type params and the status the Close menu sends.
const fetchMemexIssuesMock = vi.hoisted(() => vi.fn());
const updateIssueStatusMock = vi.hoisted(() => vi.fn());
vi.mock('../api/client', () => ({
  fetchMemexIssues: (...args: unknown[]) => fetchMemexIssuesMock(...args),
  updateIssueStatusApi: (...args: unknown[]) => updateIssueStatusMock(...args),
}));

// Mock NewSpecModal to a probe: the page test verifies the page WIRES the modal
// (open state + prefill + the onCreated→refetch contract), not the modal's own
// agent flow (covered in NewSpecModal.test.tsx + graph.test.ts). The probe
// renders the prefill it received and exposes a button to fire onCreated, which
// stands in for the real doc_created detection event.
const newSpecModalPropsSpy = vi.hoisted(() => vi.fn());
vi.mock('../components/NewSpecModal', () => ({
  NewSpecModal: (props: {
    open: boolean;
    onClose: () => void;
    prefill?: { title: string; body: string; promoteFromIssueRef: string };
    onCreated?: (info: { docId: string; handle: string; title: string }) => void;
  }) => {
    newSpecModalPropsSpy(props);
    if (!props.open) return null;
    return (
      <div data-testid="new-spec-modal">
        <div data-testid="modal-prefill-title">{props.prefill?.title}</div>
        <div data-testid="modal-prefill-body">{props.prefill?.body}</div>
        <div data-testid="modal-prefill-ref">{props.prefill?.promoteFromIssueRef}</div>
        <button
          data-testid="modal-doc-created"
          onClick={() =>
            props.onCreated?.({ docId: 'spec-99', handle: 'spec-99', title: 'Converted Spec' })
          }
        >
          simulate doc_created
        </button>
        <button data-testid="modal-abandon" onClick={() => props.onClose()}>
          abandon
        </button>
      </div>
    );
  },
}));

// PageHeader reads useAuth + tenant context; stub it to a sentinel so the page
// renders without a session (we're testing the list, not the breadcrumb).
vi.mock('../components/PageHeader', () => ({
  PageHeader: ({ title, actions }: { title: string; actions?: React.ReactNode }) => (
    <div data-testid="page-header">
      <span>{title}</span>
      {actions}
    </div>
  ),
}));

import { IssuesList } from './IssuesList';

function issue(overrides: Partial<MemexIssue> = {}): MemexIssue {
  return {
    id: 'i-1',
    seq: 1,
    type: 'bug',
    title: 'Login button is dead',
    status: 'open',
    createdAt: '2025-01-01T00:00:00.000Z',
    spec: { docId: 'd-1', handle: 'spec-3', title: 'Auth flow', status: 'build' },
    ...overrides,
  };
}

function renderPage(initialEntries: string[] = ['/acme/main/issues']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route path="/:namespace/:memex/issues" element={<IssuesList />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMemexIssuesMock.mockResolvedValue([]);
  updateIssueStatusMock.mockResolvedValue({});
});

describe('IssuesList — grouping under parent Spec (ac-7)', () => {
  it('groups issues under their parent Spec heading, freshest Spec first', async () => {
    tagAc(AC_GROUPING);
    // Two specs; the server orders rows by most-recent activity (freshest first),
    // so spec-9's row leads and its group must render before spec-3's.
    fetchMemexIssuesMock.mockResolvedValueOnce([
      issue({ id: 'i-3', seq: 3, spec: { docId: 'd-9', handle: 'spec-9', title: 'Billing', status: 'specify' } }),
      issue({ id: 'i-1', seq: 1, spec: { docId: 'd-3', handle: 'spec-3', title: 'Auth flow', status: 'build' } }),
      issue({ id: 'i-2', seq: 2, type: 'todo', spec: { docId: 'd-3', handle: 'spec-3', title: 'Auth flow', status: 'build' } }),
    ]);

    renderPage();

    const groups = await screen.findAllByTestId('issues-spec-group');
    expect(groups).toHaveLength(2);
    // First-seen order preserves the server's freshest-first ordering.
    expect(groups[0]).toHaveAttribute('data-spec-handle', 'spec-9');
    expect(groups[1]).toHaveAttribute('data-spec-handle', 'spec-3');
    // spec-3's group holds both its issues.
    expect(within(groups[1]).getAllByTestId('issue-row')).toHaveLength(2);
    // The Spec heading carries its title + a phase badge.
    expect(within(groups[1]).getByText('Auth flow')).toBeInTheDocument();
    expect(within(groups[1]).getByTestId('issues-spec-phase')).toHaveTextContent('Build');
  });
});

describe('IssuesList — row anatomy (type pill + time-ago)', () => {
  it('renders a type pill per issue type', async () => {
    tagAc(AC_TYPE_PILL);
    fetchMemexIssuesMock.mockResolvedValueOnce([
      issue({ id: 'i-1', seq: 1, type: 'bug' }),
      issue({ id: 'i-2', seq: 2, type: 'todo' }),
    ]);

    renderPage();

    const rows = await screen.findAllByTestId('issue-row');
    expect(rows[0]).toHaveAttribute('data-issue-type', 'bug');
    expect(within(rows[0]).getByText('bug')).toBeInTheDocument();
    expect(rows[1]).toHaveAttribute('data-issue-type', 'todo');
    expect(within(rows[1]).getByText('todo')).toBeInTheDocument();
  });

  it('renders a relative created time with the exact timestamp on hover', async () => {
    tagAc(AC_GROUPING);
    fetchMemexIssuesMock.mockResolvedValueOnce([
      issue({ id: 'i-1', seq: 1, createdAt: '2025-01-01T00:00:00.000Z' }),
    ]);

    renderPage();

    const row = await screen.findByTestId('issue-row');
    // TimeAgo renders a <time> element carrying the ISO instant in dateTime and
    // the full locale string in title (hover) — that's the exact-on-hover idiom.
    const time = within(row).getByText((_, el) => el?.tagName.toLowerCase() === 'time');
    expect(time).toHaveAttribute('dateTime', '2025-01-01T00:00:00.000Z');
    expect(time).toHaveAttribute('title');
    expect(time.getAttribute('title')).toBeTruthy();
  });
});

describe('IssuesList — row deep-link (ac-17)', () => {
  it('an issue row is a link to /<ns>/<mx>/specs/spec-N/issues/issue-N', async () => {
    tagAc(AC_DEEP_LINK);
    fetchMemexIssuesMock.mockResolvedValueOnce([
      issue({ id: 'i-1', seq: 4, spec: { docId: 'd-3', handle: 'spec-3', title: 'Auth flow', status: 'build' } }),
    ]);

    renderPage();

    const row = await screen.findByTestId('issue-row');
    expect(row).toHaveAttribute('href', '/acme/main/specs/spec-3/issues/issue-4');
  });

  it('clicking a row navigates to the issue deep-link path (not the actions area)', async () => {
    tagAc(AC_DEEP_LINK);
    const user = userEvent.setup();
    fetchMemexIssuesMock.mockResolvedValueOnce([
      issue({ id: 'i-1', seq: 4, spec: { docId: 'd-3', handle: 'spec-3', title: 'Auth flow', status: 'build' } }),
    ]);

    render(
      <MemoryRouter initialEntries={['/acme/main/issues']}>
        <Routes>
          <Route path="/:namespace/:memex/issues" element={<IssuesList />} />
          <Route
            path="/:namespace/:memex/specs/:id/issues/:issueId"
            element={<LocationProbe />}
          />
        </Routes>
      </MemoryRouter>,
    );

    const row = await screen.findByTestId('issue-row');
    await user.click(row);

    const probe = await screen.findByTestId('probe');
    expect(probe).toHaveAttribute('data-path', '/acme/main/specs/spec-3/issues/issue-4');
  });
});

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="probe" data-path={loc.pathname} data-search={loc.search} />;
}

describe('IssuesList — filters compose + round-trip through the URL', () => {
  it('hydrates phase/type checkboxes from the URL query string', async () => {
    renderPage(['/acme/main/issues?phases=build,verify&types=bug']);

    // Phase: only build + verify checked.
    await waitFor(() => expect(screen.getByTestId('issues-phase-build')).toBeChecked());
    expect(screen.getByTestId('issues-phase-verify')).toBeChecked();
    expect(screen.getByTestId('issues-phase-draft')).not.toBeChecked();
    expect(screen.getByTestId('issues-phase-specify')).not.toBeChecked();
    expect(screen.getByTestId('issues-phase-done')).not.toBeChecked();
    // Type: only bug checked.
    expect(screen.getByTestId('issues-type-bug')).toBeChecked();
    expect(screen.getByTestId('issues-type-todo')).not.toBeChecked();
  });

  it('active phases + types are checked by default; done ships UNCHECKED (spec-164)', async () => {
    tagAc(AC_PHASE_FILTER);
    // spec-164 scope ac-7: issues on done specs are an explicit opt-in.
    tagAc('mindset-prod/memex-building-itself/specs/spec-164/acs/ac-7');
    renderPage();

    for (const phase of ['draft', 'specify', 'build', 'verify']) {
      expect(await screen.findByTestId(`issues-phase-${phase}`)).toBeChecked();
    }
    expect(screen.getByTestId('issues-phase-done')).not.toBeChecked();
    expect(screen.getByTestId('issues-type-bug')).toBeChecked();
    expect(screen.getByTestId('issues-type-todo')).toBeChecked();
  });

  it('checking done writes the explicit opt-in to the URL and round-trips (spec-164)', async () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-164/acs/ac-7');
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/acme/main/issues']}>
        <Routes>
          <Route path="/:namespace/:memex/issues" element={<IssuesList />} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>,
    );

    await screen.findByTestId('issues-phase-done');
    await user.click(screen.getByTestId('issues-phase-done'));

    // The opt-in serialises all five phases explicitly…
    await waitFor(() => {
      const search = screen.getByTestId('probe').getAttribute('data-search') ?? '';
      const phases = new URLSearchParams(search).get('phases');
      expect(phases).not.toBeNull();
      expect(phases!.split(',').sort()).toEqual(['build', 'done', 'draft', 'specify', 'verify']);
    });

    // …and unchecking done returns to the clean default URL (param dropped).
    await user.click(screen.getByTestId('issues-phase-done'));
    await waitFor(() => {
      const search = screen.getByTestId('probe').getAttribute('data-search') ?? '';
      expect(new URLSearchParams(search).get('phases')).toBeNull();
    });
  });

  it('toggling a phase checkbox writes the explicit selection to the URL and refetches', async () => {
    tagAc(AC_PHASE_FILTER);
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/acme/main/issues']}>
        <Routes>
          <Route path="/:namespace/:memex/issues" element={<IssuesList />} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>,
    );

    // Uncheck draft → the param lists the remaining phases of the default
    // set (done is already off by default per spec-164).
    await screen.findByTestId('issues-phase-draft');
    await user.click(screen.getByTestId('issues-phase-draft'));

    await waitFor(() => {
      const probe = screen.getByTestId('probe');
      const search = probe.getAttribute('data-search') ?? '';
      const params = new URLSearchParams(search);
      const phases = params.get('phases');
      expect(phases).not.toBeNull();
      expect(phases!.split(',').sort()).toEqual(['build', 'specify', 'verify']);
    });

    // The fetch ran again with exactly the remaining phases.
    await waitFor(() => {
      const lastCall = fetchMemexIssuesMock.mock.calls.at(-1)![0];
      expect([...lastCall.phases].sort()).toEqual(['build', 'specify', 'verify']);
    });
  });
});

describe('IssuesList — scope switch hits the endpoint with the right params', () => {
  it('defaults to scope "mine" and switching to Everyone sends scope "all"', async () => {
    tagAc(AC_SCOPE);
    const user = userEvent.setup();
    renderPage();

    // Initial fetch is the default scope: 'mine'.
    await waitFor(() => expect(fetchMemexIssuesMock).toHaveBeenCalled());
    expect(fetchMemexIssuesMock.mock.calls[0][0]).toMatchObject({ scope: 'mine' });

    // Flip the scope control to Everyone.
    await user.click(screen.getByRole('radio', { name: 'Everyone' }));

    await waitFor(() => {
      const lastCall = fetchMemexIssuesMock.mock.calls.at(-1)![0];
      expect(lastCall).toMatchObject({ scope: 'all' });
    });
  });
});

describe('IssuesList — empty states', () => {
  it('the Mine-scope empty state explains the scope and offers Everyone', async () => {
    tagAc(AC_SCOPE);
    fetchMemexIssuesMock.mockResolvedValue([]);
    const user = userEvent.setup();
    renderPage();

    const empty = await screen.findByTestId('issues-empty-mine');
    expect(empty).toBeInTheDocument();

    // The "Show everyone's issues" affordance flips scope → 'all'.
    await user.click(screen.getByTestId('issues-empty-everyone'));
    await waitFor(() => {
      const lastCall = fetchMemexIssuesMock.mock.calls.at(-1)![0];
      expect(lastCall).toMatchObject({ scope: 'all' });
    });
  });

  it('an empty Everyone scope gets the calm all-clear', async () => {
    fetchMemexIssuesMock.mockResolvedValue([]);
    renderPage(['/acme/main/issues?scope=everyone']);

    expect(await screen.findByTestId('issues-empty-all')).toBeInTheDocument();
    expect(screen.getByText(/all clear/i)).toBeInTheDocument();
  });
});

describe("IssuesList — Close menu resolves / won't-fix and removes the row (ac-18)", () => {
  it('the Close menu offers both Resolve and Won\'t fix', async () => {
    tagAc(AC_CLOSE);
    tagAc(AC_ROW_ACTIONS);
    const user = userEvent.setup();
    fetchMemexIssuesMock.mockResolvedValueOnce([issue({ id: 'i-1', seq: 1 })]);

    renderPage();

    const row = await screen.findByTestId('issue-row');
    // The ⋯ Close menu lives in the row's actions area.
    await user.click(within(row).getByRole('button', { name: 'Close issue' }));

    expect(await screen.findByRole('menuitem', { name: 'Resolve' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: "Won't fix" })).toBeInTheDocument();
  });

  it('Resolve calls the resolve API with status "resolved" and removes the row', async () => {
    tagAc(AC_CLOSE);
    const user = userEvent.setup();
    fetchMemexIssuesMock.mockResolvedValueOnce([
      issue({ id: 'i-1', seq: 1, title: 'Login button is dead' }),
      issue({ id: 'i-2', seq: 2, title: 'Survivor issue' }),
    ]);

    renderPage();

    await waitFor(() => expect(screen.getAllByTestId('issue-row')).toHaveLength(2));
    const target = screen
      .getAllByTestId('issue-row')
      .find((r) => r.getAttribute('data-issue-handle') === 'issue-1')!;

    await user.click(within(target).getByRole('button', { name: 'Close issue' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Resolve' }));

    // An OK/Cancel confirmation gates the mutation — nothing happens until OK.
    expect(updateIssueStatusMock).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog', { name: 'Resolve this issue?' });
    await user.click(within(dialog).getByRole('button', { name: 'Resolve' }));

    // The EXISTING resolve path is called with the issue id + 'resolved'.
    await waitFor(() =>
      expect(updateIssueStatusMock).toHaveBeenCalledWith('i-1', 'resolved'),
    );
    // The resolved row leaves the open list; its sibling stays.
    await waitFor(() => {
      const handles = screen
        .getAllByTestId('issue-row')
        .map((r) => r.getAttribute('data-issue-handle'));
      expect(handles).toEqual(['issue-2']);
    });
  });

  it("Won't fix calls the resolve API with status \"wont_fix\" and removes the row", async () => {
    tagAc(AC_CLOSE);
    const user = userEvent.setup();
    fetchMemexIssuesMock.mockResolvedValueOnce([issue({ id: 'i-1', seq: 1 })]);

    renderPage();

    const row = await screen.findByTestId('issue-row');
    await user.click(within(row).getByRole('button', { name: 'Close issue' }));
    await user.click(await screen.findByRole('menuitem', { name: "Won't fix" }));

    // Confirmation gate, then the mutation.
    const dialog = await screen.findByRole('dialog', { name: "Mark this issue as won't fix?" });
    await user.click(within(dialog).getByRole('button', { name: "Won't fix" }));

    await waitFor(() =>
      expect(updateIssueStatusMock).toHaveBeenCalledWith('i-1', 'wont_fix'),
    );
    // The only open issue is now gone — the all-clear empty state takes over.
    await waitFor(() => expect(screen.queryByTestId('issue-row')).not.toBeInTheDocument());
  });

  it('Cancel in the confirmation dialog leaves the issue untouched', async () => {
    tagAc(AC_CLOSE);
    const user = userEvent.setup();
    fetchMemexIssuesMock.mockResolvedValueOnce([issue({ id: 'i-1', seq: 1 })]);

    renderPage();

    const row = await screen.findByTestId('issue-row');
    await user.click(within(row).getByRole('button', { name: 'Close issue' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Resolve' }));

    const dialog = await screen.findByRole('dialog', { name: 'Resolve this issue?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    // No mutation, dialog gone, row still in place.
    expect(updateIssueStatusMock).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByTestId('issue-row')).toHaveAttribute('data-issue-handle', 'issue-1');
  });
});

describe('IssuesList — Convert to Spec opens a prefilled NewSpecModal (ac-19)', () => {
  it('Convert opens the modal prefilled with the issue title + the promote ref', async () => {
    tagAc(AC_CONVERT);
    tagAc(AC_ROW_ACTIONS);
    const user = userEvent.setup();
    fetchMemexIssuesMock.mockResolvedValueOnce([
      issue({
        id: 'i-1',
        seq: 7,
        title: 'Search returns stale hits',
        spec: { docId: 'd-3', handle: 'spec-3', title: 'Auth flow', status: 'build' },
      }),
    ]);

    renderPage();

    const row = await screen.findByTestId('issue-row');
    // Modal starts closed.
    expect(screen.queryByTestId('new-spec-modal')).not.toBeInTheDocument();

    await user.click(within(row).getByRole('button', { name: 'Convert to Spec' }));

    const modal = await screen.findByTestId('new-spec-modal');
    // Prefilled with the issue's content (title) so the user can elaborate.
    expect(within(modal).getByTestId('modal-prefill-title')).toHaveTextContent(
      'Search returns stale hits',
    );
    // ...and carrying the Issue's canonical ref, wired to promoteFromIssueRef so
    // creation routes through create_doc's promote path.
    expect(within(modal).getByTestId('modal-prefill-ref')).toHaveTextContent(
      'acme/main/specs/spec-3/issues/issue-7',
    );
  });

  it('a confirmed doc_created refetches the list (the converted Issue drops out)', async () => {
    tagAc(AC_CONVERT);
    const user = userEvent.setup();
    // Initial load: one open issue. After creation the server has flipped it to
    // converted, so the refetch returns an empty open list.
    fetchMemexIssuesMock
      .mockResolvedValueOnce([issue({ id: 'i-1', seq: 7, title: 'Search returns stale hits' })])
      .mockResolvedValueOnce([]);

    renderPage();

    const row = await screen.findByTestId('issue-row');
    await user.click(within(row).getByRole('button', { name: 'Convert to Spec' }));

    const initialFetches = fetchMemexIssuesMock.mock.calls.length;

    // Simulate the modal's doc_created detection firing onCreated.
    await user.click(await screen.findByTestId('modal-doc-created'));

    // The page refetched after the confirmed creation...
    await waitFor(() =>
      expect(fetchMemexIssuesMock.mock.calls.length).toBeGreaterThan(initialFetches),
    );
    // ...a confirmation dialog names the new Spec...
    const dialog = await screen.findByRole('dialog', { name: 'Issue converted to Spec' });
    expect(within(dialog).getByText(/spec-99/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));

    // ...and the now-converted Issue is gone (modal closed, list empty).
    await waitFor(() => expect(screen.queryByTestId('issue-row')).not.toBeInTheDocument());
    expect(screen.queryByTestId('new-spec-modal')).not.toBeInTheDocument();
  });

  it('abandoning the modal leaves the Issue open and its row in place', async () => {
    tagAc(AC_CONVERT);
    const user = userEvent.setup();
    // The list never refetches on abandon, so the original row stays.
    fetchMemexIssuesMock.mockResolvedValue([
      issue({ id: 'i-1', seq: 7, title: 'Search returns stale hits' }),
    ]);

    renderPage();

    const row = await screen.findByTestId('issue-row');
    await user.click(within(row).getByRole('button', { name: 'Convert to Spec' }));
    await screen.findByTestId('new-spec-modal');

    // Close/abandon the modal WITHOUT a doc_created event.
    await user.click(screen.getByTestId('modal-abandon'));

    // No resolve call, no conversion marked client-side — the row is still open.
    expect(updateIssueStatusMock).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId('new-spec-modal')).not.toBeInTheDocument());
    expect(screen.getByTestId('issue-row')).toHaveAttribute('data-issue-handle', 'issue-7');
  });
});

// spec-164 dec-1 / ac-13 — the Issues page routes phase names through the
// shared display-name layer: the phase filter and the per-Spec phase badge
// read "Specify" for the `specify` enum value (which is also the URL/param value
// now — spec-181 renamed the enum end-to-end).
describe('IssuesList — phase display names (spec-164)', () => {
  const AC_DISPLAY = 'mindset-prod/memex-building-itself/specs/spec-164/acs/ac-13';

  it('the phase filter checkbox for `specify` is labelled "Specify" and the param stays `specify`', async () => {
    tagAc(AC_DISPLAY);
    renderPage();
    await screen.findByTestId('issues-filter-bar');
    const checkbox = screen.getByTestId('issues-phase-specify');
    expect(checkbox.closest('label')).toHaveTextContent('Specify');
  });

  it('the parent-Spec phase badge renders the display name for a specify spec', async () => {
    tagAc(AC_DISPLAY);
    fetchMemexIssuesMock.mockResolvedValue([
      issue({ spec: { docId: 'd-1', handle: 'spec-3', title: 'Auth flow', status: 'specify' } }),
    ]);
    renderPage();
    expect(await screen.findByTestId('issues-spec-phase')).toHaveTextContent('Specify');
  });
});
