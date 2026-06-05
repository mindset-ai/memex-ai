import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const listMyNamespacesApi = vi.hoisted(() => vi.fn());
const getNamespaceHomeApi = vi.hoisted(() => vi.fn());

vi.mock('../api/client', () => ({
  listMyNamespacesApi,
  getNamespaceHomeApi,
}));

vi.mock('../components/AuthContext', () => ({
  useAuth: () => ({ token: 'fake', session: { user: { id: 'u-1' } } }),
}));

vi.mock('../components/AddMemexDialog', () => ({
  AddMemexDialog: () => <div data-testid="add-memex-dialog" />,
}));

vi.mock('../components/CreateOrgDialog', () => ({
  CreateOrgDialog: () => <div data-testid="create-org-dialog" />,
}));

import { NamespaceHome } from './NamespaceHome';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/:namespace" element={<NamespaceHome />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('NamespaceHome', () => {
  beforeEach(() => {
    listMyNamespacesApi.mockReset();
    getNamespaceHomeApi.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders the org variant with the Memex list', async () => {
    listMyNamespacesApi.mockResolvedValue([
      { namespaceId: 'ns-1', namespaceSlug: 'acme', kind: 'team', memexes: [] },
    ]);
    getNamespaceHomeApi.mockResolvedValue({
      kind: 'org',
      org: { id: 'org-1', name: 'Acme Co', slug: 'acme' },
      memexes: [
        { id: 'mx-1', slug: 'main', name: 'Main', lastActivityAt: '2026-05-01T00:00:00Z' },
      ],
      memberCount: 3,
      currentRole: 'administrator',
    });

    renderAt('/acme');
    await waitFor(() => expect(screen.getByText('Acme Co')).toBeInTheDocument());
    expect(screen.getByText(/3 members/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Add Memex/ })[0]).toBeInTheDocument();
    expect(screen.getByText('Main')).toBeInTheDocument();
  });

  it('renders the empty-state copy when the org has no memexes', async () => {
    listMyNamespacesApi.mockResolvedValue([
      { namespaceId: 'ns-2', namespaceSlug: 'empty', kind: 'team', memexes: [] },
    ]);
    getNamespaceHomeApi.mockResolvedValue({
      kind: 'org',
      org: { id: 'org-2', name: 'Empty Inc', slug: 'empty' },
      memexes: [],
      memberCount: 1,
      currentRole: 'administrator',
    });

    renderAt('/empty');
    await waitFor(() => expect(screen.getByText('Empty Inc')).toBeInTheDocument());
    expect(screen.getByText(/No Memexes yet/)).toBeInTheDocument();
    expect(screen.getByText(/Add Memex/)).toBeInTheDocument();
  });

  it('renders the personal variant with the Create-Org CTA', async () => {
    listMyNamespacesApi.mockResolvedValue([
      { namespaceId: 'ns-3', namespaceSlug: 'alice', kind: 'personal', memexes: [] },
    ]);
    getNamespaceHomeApi.mockResolvedValue({
      kind: 'personal',
      memex: { id: 'mx-p', slug: 'personal', name: 'Personal Memex' },
    });

    renderAt('/alice');
    await waitFor(() => expect(screen.getByText('Your personal Memex')).toBeInTheDocument());
    expect(screen.getByText(/Yours forever/)).toBeInTheDocument();
    expect(screen.getByText('Working with a team?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create an Org/ })).toBeInTheDocument();
  });

  it('shows an error when the namespace is not in the picker list', async () => {
    listMyNamespacesApi.mockResolvedValue([]);
    renderAt('/missing');
    await waitFor(() =>
      expect(screen.getByText(/Failed to load namespace/)).toBeInTheDocument(),
    );
  });
});
