// spec-418 t-5 — the Manage-tags surface: route, grouped list, counts, search,
// and the no-new-nav-item guarantee. RTL/jsdom. Each `it` tags the AC it proves.
//
// The list data comes from fetchMemexTagsWithCounts (mocked). PageHeader pulls
// AuthContext for the breadcrumb, so we stub it (same shape as the Skills/Standards
// list tests) — the test asserts against the page BODY, not the breadcrumb.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import { ManageTags } from './ManageTags';
import type { TagWithCount } from '../api/docs';

const AC = 'mindset-prod/memex-building-itself/specs/spec-418/acs';
const SRC_DIR = dirname(fileURLToPath(import.meta.url));

const fetchWithCountsMock = vi.fn();
vi.mock('../api/docs', async () => {
  const actual = await vi.importActual<typeof import('../api/docs')>('../api/docs');
  return { ...actual, fetchMemexTagsWithCounts: (...a: unknown[]) => fetchWithCountsMock(...a) };
});

// t-6 added a live-refresh subscription (useDocChangeStream) to the surface. Stub
// it so this t-5 suite renders without an AuthProvider / SSE fetch — the hook's
// own behaviour is covered in hooks/useDocChangeStream.test.tsx.
vi.mock('../hooks/useDocChangeStream', () => ({ useDocChangeStream: vi.fn() }));

// PageHeader reaches into AuthContext for the breadcrumb — stub it like the
// Standards/Skills list tests so the page renders standalone.
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

beforeEach(() => {
  vi.clearAllMocks();
  fetchWithCountsMock.mockResolvedValue(CATALOGUE);
});

describe('ManageTags — route registered (ac-8)', () => {
  it('registers the /specs/tags route and renders the surface', async () => {
    tagAc(`${AC}/ac-8`);

    // The route is registered in App.tsx as a child of the tenant parent.
    const appSource = readFileSync(join(SRC_DIR, '../App.tsx'), 'utf8');
    expect(appSource).toContain('path="specs/tags"');
    expect(appSource).toContain('ManageTags');

    // And the surface itself renders (its "New tag" action is a stable anchor).
    // The "NO new nav item" and "sidebar-not-doc-chrome" halves of ac-8/ac-9 are
    // proven BEHAVIOURALLY against the real rendered nav in
    // components/AppShell.spec-418.test.tsx — a source-text `to:` regex here would
    // miss a nav entry added via a template literal / double quotes / spread.
    renderPage();
    expect(await screen.findByTestId('manage-tags-new')).toBeInTheDocument();
  });
});

describe('ManageTags — grouped, alphabetical, counted list (ac-1)', () => {
  it('renders every tag grouped by scope, alphabetical within a group, with counts, reusing TagChip', async () => {
    tagAc(`${AC}/ac-1`);
    renderPage();

    // One TagChip per tag (the existing component, reused — not forked).
    const chips = await screen.findAllByTestId('tag-chip');
    expect(chips).toHaveLength(CATALOGUE.length);

    // A dedicated group for flat (unscoped) tags is present.
    expect(screen.getByTestId('tag-group-flat')).toBeInTheDocument();

    // Alphabetical within the priority scope: high before low.
    const rows = screen.getAllByTestId('tag-row');
    const rowText = rows.map((r) => r.textContent ?? '');
    const highIdx = rowText.findIndex((t) => t.includes('high'));
    const lowIdx = rowText.findIndex((t) => t.includes('low'));
    expect(highIdx).toBeGreaterThanOrEqual(0);
    expect(highIdx).toBeLessThan(lowIdx);

    // Alphabetical within the flat group: api before bug.
    const apiIdx = rowText.findIndex((t) => t.includes('api'));
    const bugIdx = rowText.findIndex((t) => t.includes('bug'));
    expect(apiIdx).toBeLessThan(bugIdx);

    // Each row shows its assigned count.
    const counts = screen.getAllByTestId('tag-count').map((n) => n.textContent);
    expect(counts).toEqual(expect.arrayContaining(['3', '1', '2', '5', '0']));
  });

  it('exposes per-row Rename and Delete buttons that are keyboard-focusable (ac-1)', async () => {
    tagAc(`${AC}/ac-1`);
    renderPage();

    const renameButtons = await screen.findAllByRole('button', { name: /rename/i });
    const deleteButtons = screen.getAllByRole('button', { name: /delete/i });
    expect(renameButtons).toHaveLength(CATALOGUE.length);
    expect(deleteButtons).toHaveLength(CATALOGUE.length);
    // Focusable: a real <button> is in the tab order (not tabindex=-1).
    renameButtons[0].focus();
    expect(renameButtons[0]).toHaveFocus();
  });
});

describe('ManageTags — all-member access, no admin gate (ac-5)', () => {
  it('renders the catalogue for a plain member with no admin-only guard', async () => {
    tagAc(`${AC}/ac-5`);
    renderPage();

    // The list renders for a normal member (no session/admin stub needed) — there
    // is no administrator gate short-circuiting the surface.
    expect(await screen.findAllByTestId('tag-chip')).toHaveLength(CATALOGUE.length);
    expect(screen.queryByText(/administrator/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/only admins/i)).not.toBeInTheDocument();
  });
});

describe('ManageTags — minimal copy, guidance behind ⓘ (ac-23)', () => {
  it('shows NO standing description paragraph; guidance lives behind an info affordance', async () => {
    tagAc(`${AC}/ac-23`);
    renderPage();

    await screen.findAllByTestId('tag-chip');

    // The ⓘ affordance exists…
    const info = screen.getByTestId('manage-tags-info');
    expect(info).toBeInTheDocument();

    // …and there is no standing guidance paragraph until the ⓘ is opened.
    expect(screen.queryByTestId('manage-tags-guidance')).not.toBeInTheDocument();
    fireEvent.click(info);
    expect(screen.getByTestId('manage-tags-guidance')).toBeInTheDocument();
  });
});

describe('ManageTags — search narrows the list (ac-35)', () => {
  it('filters visible tags by scope/value substring', async () => {
    tagAc(`${AC}/ac-35`);
    renderPage();

    await screen.findAllByTestId('tag-chip');
    fireEvent.change(screen.getByTestId('manage-tags-search'), { target: { value: 'high' } });

    const visible = screen.getAllByTestId('tag-chip').map((c) => c.textContent);
    expect(visible.some((t) => t?.includes('high'))).toBe(true);
    expect(visible.some((t) => t?.includes('bug'))).toBe(false);
    expect(visible.some((t) => t?.includes('low'))).toBe(false);

    // Matching on SCOPE substring also narrows (priority::* both return).
    fireEvent.change(screen.getByTestId('manage-tags-search'), { target: { value: 'priority' } });
    const byScope = screen.getAllByTestId('tag-chip').map((c) => c.textContent);
    expect(byScope.some((t) => t?.includes('high'))).toBe(true);
    expect(byScope.some((t) => t?.includes('low'))).toBe(true);
    expect(byScope.some((t) => t?.includes('mcp'))).toBe(false);
  });
});
