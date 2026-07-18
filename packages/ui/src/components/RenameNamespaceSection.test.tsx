import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';

// spec-481 t-2 — component-level verification of the namespace-slug rename.
// Proves the UI behaviour (gated on live availability, states consequences
// before commit, then renames + refreshes the session BEFORE navigating to the
// new /<new-ns>/ home) with the API + router mocked. The full-page journey
// (journey-62) covers ac-2's old-link forward end-to-end in CI's cold-DB gate.
const AC_UI = 'mindset-prod/memex-building-itself/specs/spec-481/acs/ac-4';

const navigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual =
    await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});

const refreshSession = vi.fn();
vi.mock('./AuthContext', () => ({
  useAuth: () => ({ token: 'test-token', refreshSession }),
}));

const checkNamespaceSlugApi = vi.fn();
const renameNamespaceSlugApi = vi.fn();
vi.mock('../api/client', () => ({
  checkNamespaceSlugApi: (...a: unknown[]) => checkNamespaceSlugApi(...a),
  renameNamespaceSlugApi: (...a: unknown[]) => renameNamespaceSlugApi(...a),
}));

import { RenameNamespaceSection } from './RenameNamespaceSection';

beforeEach(() => {
  vi.clearAllMocks();
  refreshSession.mockResolvedValue(undefined);
});

function renderSection() {
  return render(
    <MemoryRouter>
      <RenameNamespaceSection namespaceId="ns-uuid" currentSlug="acme" />
    </MemoryRouter>,
  );
}

describe('RenameNamespaceSection (spec-481 t-2)', () => {
  it('gates on availability, confirms consequences, then renames + refreshes before navigating', async () => {
    tagAc(AC_UI);
    checkNamespaceSlugApi.mockResolvedValue({ available: true });
    renameNamespaceSlugApi.mockResolvedValue({ namespace: { id: 'ns-uuid', slug: 'globex' } });
    const user = userEvent.setup();
    renderSection();

    const slugInput = await screen.findByTestId('namespace-slug-input');
    await user.clear(slugInput);
    await user.type(slugInput, 'globex');

    const renameBtn = screen.getByTestId('namespace-slug-rename');
    await waitFor(() => expect(renameBtn).toBeEnabled());
    await user.click(renameBtn);

    // Consequences stated BEFORE commit (30-day cooldown + old links forward).
    const confirm = await screen.findByTestId('namespace-slug-confirm');
    expect(confirm).toHaveTextContent(/forward/i);
    expect(confirm).toHaveTextContent(/30 days/i);

    await user.click(screen.getByTestId('namespace-slug-confirm-btn'));
    await waitFor(() =>
      expect(renameNamespaceSlugApi).toHaveBeenCalledWith('ns-uuid', 'globex', 'test-token'),
    );
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    // The session MUST refresh before navigating — otherwise TenantLayout gates
    // tenant URLs on stale membership (old slug) and bounces the user. This is
    // the spec-479 journey-61 regression, carried forward.
    expect(refreshSession).toHaveBeenCalled();
    expect(refreshSession.mock.invocationCallOrder[0]).toBeLessThan(
      navigate.mock.invocationCallOrder[0],
    );
    // ac-4: navigates to the new /<new-ns>/ home.
    expect(navigate).toHaveBeenCalledWith('/globex', { replace: true });
  });

  it('blocks the rename and explains when the slug is reserved by a prior rename', async () => {
    tagAc(AC_UI);
    checkNamespaceSlugApi.mockResolvedValue({ available: false, reason: 'redirected' });
    const user = userEvent.setup();
    renderSection();

    const slugInput = await screen.findByTestId('namespace-slug-input');
    await user.clear(slugInput);
    await user.type(slugInput, 'oldname');

    await waitFor(() =>
      expect(screen.getByTestId('namespace-slug-unavailable')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('namespace-slug-unavailable')).toHaveTextContent(/reserved/i);
    expect(screen.getByTestId('namespace-slug-rename')).toBeDisabled();
  });
});
