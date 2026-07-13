import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';

// spec-479 t-4 — component-level verification of the rename controls. Proves the
// UI behaviour (name saves via the API; slug rename is gated on live
// availability, states consequences before commit, then renames + navigates to
// the new URL) with the API + router mocked. The full-page journey (journey-61)
// covers ac-1 end-to-end in CI's cold-DB gate.
const AC_UI = 'mindset-prod/memex-building-itself/specs/spec-479/acs/ac-7';
const AC_UX = 'mindset-prod/memex-building-itself/specs/spec-479/acs/ac-4';

const navigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual =
    await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});

vi.mock('./AuthContext', () => ({
  useAuth: () => ({ token: 'test-token' }),
}));

const fetchMemexApi = vi.fn();
const updateMemexNameApi = vi.fn();
const renameMemexSlugApi = vi.fn();
const checkMemexSlugApi = vi.fn();
vi.mock('../api/client', () => ({
  fetchMemexApi: (...a: unknown[]) => fetchMemexApi(...a),
  updateMemexNameApi: (...a: unknown[]) => updateMemexNameApi(...a),
  renameMemexSlugApi: (...a: unknown[]) => renameMemexSlugApi(...a),
  checkMemexSlugApi: (...a: unknown[]) => checkMemexSlugApi(...a),
}));

import { RenameMemexSection } from './RenameMemexSection';

const MEMEX = {
  id: 'm1',
  namespaceId: 'ns-uuid',
  slug: 'workspace',
  name: 'Workspace',
  visibility: 'private' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  fetchMemexApi.mockResolvedValue({ ...MEMEX });
});

function renderSection() {
  return render(
    <MemoryRouter>
      <RenameMemexSection memexId="m1" namespaceSlug="ns" />
    </MemoryRouter>,
  );
}

describe('RenameMemexSection (spec-479 t-4)', () => {
  it('saves the display name via updateMemexNameApi and shows no slug confirm', async () => {
    tagAc(AC_UI);
    updateMemexNameApi.mockResolvedValue({ ...MEMEX, name: 'Renamed' });
    const user = userEvent.setup();
    renderSection();

    const nameInput = await screen.findByTestId('memex-name-input');
    await user.clear(nameInput);
    await user.type(nameInput, 'Renamed');
    await user.click(screen.getByTestId('memex-name-save'));

    await waitFor(() =>
      expect(updateMemexNameApi).toHaveBeenCalledWith('m1', 'Renamed', 'test-token'),
    );
    expect(await screen.findByText('Name saved.')).toBeInTheDocument();
    // ac-4: a name change never surfaces the slug consequence confirm.
    expect(screen.queryByTestId('memex-slug-confirm')).toBeNull();
  });

  it('gates the slug rename on availability, confirms consequences, then renames + navigates', async () => {
    tagAc(AC_UI);
    tagAc(AC_UX);
    checkMemexSlugApi.mockResolvedValue({ available: true });
    renameMemexSlugApi.mockResolvedValue({ ...MEMEX, slug: 'renamed' });
    const user = userEvent.setup();
    renderSection();

    const slugInput = await screen.findByTestId('memex-slug-input');
    await user.clear(slugInput);
    await user.type(slugInput, 'renamed');

    const renameBtn = screen.getByTestId('memex-slug-rename');
    await waitFor(() => expect(renameBtn).toBeEnabled());
    await user.click(renameBtn);

    // ac-4: consequences stated BEFORE commit.
    const confirm = await screen.findByTestId('memex-slug-confirm');
    expect(confirm).toHaveTextContent(/forward/i);

    await user.click(screen.getByTestId('memex-slug-confirm-btn'));
    await waitFor(() =>
      expect(renameMemexSlugApi).toHaveBeenCalledWith('m1', 'renamed', 'test-token'),
    );
    // ac-7: navigates to the new /<ns>/<new-slug>/settings URL.
    expect(navigate).toHaveBeenCalledWith('/ns/renamed/settings', { replace: true });
  });

  it('blocks the rename and explains when the slug is reserved by a prior rename', async () => {
    tagAc(AC_UX);
    checkMemexSlugApi.mockResolvedValue({ available: false, reason: 'redirected' });
    const user = userEvent.setup();
    renderSection();

    const slugInput = await screen.findByTestId('memex-slug-input');
    await user.clear(slugInput);
    await user.type(slugInput, 'oldname');

    await waitFor(() =>
      expect(screen.getByTestId('memex-slug-unavailable')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('memex-slug-unavailable')).toHaveTextContent(/reserved/i);
    expect(screen.getByTestId('memex-slug-rename')).toBeDisabled();
  });
});
