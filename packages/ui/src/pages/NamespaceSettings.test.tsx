import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';

// spec-481 t-2 (ac-1) — the settings page shows the rename control only to an
// administrator, and hides it (std-7 posture) from a non-admin member. Resolves
// the namespace + role from the caller's own namespace list.
const AC_SCOPE = 'mindset-prod/memex-building-itself/specs/spec-481/acs/ac-1';

vi.mock('../components/AuthContext', () => ({
  useAuth: () => ({ token: 'test-token', refreshSession: vi.fn() }),
}));

const listMyNamespacesApi = vi.fn();
vi.mock('../api/client', () => ({
  listMyNamespacesApi: (...a: unknown[]) => listMyNamespacesApi(...a),
}));

// The rename section is exercised in its own test; stub it so this test targets
// the page's resolve + authorize logic in isolation.
vi.mock('../components/RenameNamespaceSection', () => ({
  RenameNamespaceSection: ({ currentSlug }: { currentSlug: string }) => (
    <div data-testid="rename-section">rename {currentSlug}</div>
  ),
}));

import { NamespaceSettings } from './NamespaceSettings';

function renderAt(slug: string) {
  return render(
    <MemoryRouter initialEntries={[`/${slug}/settings`]}>
      <Routes>
        <Route path="/:namespace/settings" element={<NamespaceSettings />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => vi.clearAllMocks());

describe('NamespaceSettings (spec-481 t-2)', () => {
  it('renders the rename control for an administrator', async () => {
    tagAc(AC_SCOPE);
    listMyNamespacesApi.mockResolvedValue([
      { namespaceId: 'ns-1', namespaceSlug: 'acme', kind: 'team', role: 'administrator', memexes: [] },
    ]);
    renderAt('acme');
    expect(await screen.findByTestId('rename-section')).toHaveTextContent('rename acme');
  });

  it('hides the control from a non-admin member', async () => {
    tagAc(AC_SCOPE);
    listMyNamespacesApi.mockResolvedValue([
      { namespaceId: 'ns-1', namespaceSlug: 'acme', kind: 'team', role: 'member', memexes: [] },
    ]);
    renderAt('acme');
    await waitFor(() =>
      expect(screen.getByText(/only administrators/i)).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('rename-section')).toBeNull();
  });
});
