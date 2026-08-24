import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { tagAc } from '@memex-ai-ac/vitest';

// spec-537 t-3 — component-level verification of the profile name editor, with the
// API and auth context mocked. The full-page journey (t-4) covers the no-reload
// repaint end-to-end in CI's cold-DB gate.
const SPEC = 'mindset-prod/memex-building-itself/specs/spec-537';
const AC_FIELDS = `${SPEC}/acs/ac-9`;   // name editable + email read-only, with copy
const AC_ABSENT = `${SPEC}/acs/ac-10`;  // no avatar / no role triangle / name-only body
const AC_SAVE = `${SPEC}/acs/ac-11`;    // one PATCH via updateProfileApi, session adopted
const AC_GUARD = `${SPEC}/acs/ac-12`;   // save disabled empty/unchanged; error in place
const AC_SILENT = `${SPEC}/acs/ac-14`;  // no attribution copy, no confirm dialog

const USER = { id: 'u1', name: 'Ada Lovelace', email: 'ada@example.com', picture: '' };

const updateSession = vi.fn();
vi.mock('./AuthContext', () => ({
  useAuth: () => ({ token: 'test-token', user: USER, updateSession }),
}));

const updateProfileApi = vi.fn();
vi.mock('../api/client', () => ({
  updateProfileApi: (...a: unknown[]) => updateProfileApi(...a),
}));

import { ProfileNameSection } from './ProfileNameSection';

beforeEach(() => {
  vi.clearAllMocks();
  updateProfileApi.mockResolvedValue({ user: { ...USER, name: 'Ada B' } });
});

const nameInput = () => screen.getByTestId('profile-name-input');
const saveButton = () => screen.getByTestId('profile-name-save');

describe('ProfileNameSection', () => {
  it('pre-fills the name from the session and shows the email read-only', () => {
    tagAc(AC_FIELDS);
    render(<ProfileNameSection />);

    expect(nameInput()).toHaveValue('Ada Lovelace');
    expect(nameInput()).not.toBeDisabled();
    expect(nameInput()).toHaveAttribute('maxlength', '100');

    const email = screen.getByTestId('profile-email');
    expect(email).toHaveValue('ada@example.com');
    expect(email).toBeDisabled();
    // std-34: the boundary is stated, not implied by leaving the field out.
    expect(screen.getByText(/can't be changed here/i)).toBeInTheDocument();
  });

  it('renders no avatar and no role triangle, and sends the name only', async () => {
    tagAc(AC_ABSENT);
    render(<ProfileNameSection />);

    // spec-296 owns the avatar; spec-433 parked the role triangle.
    expect(screen.queryByTestId('role-triangle')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();

    await userEvent.clear(nameInput());
    await userEvent.type(nameInput(), 'Ada B');
    await userEvent.click(saveButton());

    await waitFor(() => expect(updateProfileApi).toHaveBeenCalledTimes(1));
    // Only (token, name) — a third roleCoords argument would write to a dormant field.
    expect(updateProfileApi.mock.calls[0]).toEqual(['test-token', 'Ada B']);
  });

  it('saves once and adopts the returned session', async () => {
    tagAc(AC_SAVE);
    render(<ProfileNameSection />);

    await userEvent.clear(nameInput());
    await userEvent.type(nameInput(), 'Ada B');
    await userEvent.click(saveButton());

    await waitFor(() => expect(updateSession).toHaveBeenCalledTimes(1));
    expect(updateSession).toHaveBeenCalledWith({ user: { ...USER, name: 'Ada B' } });
    expect(updateProfileApi).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/name saved/i)).toBeInTheDocument();
  });

  it('disables save while the name is unchanged, blank, or whitespace-only', async () => {
    tagAc(AC_GUARD);
    render(<ProfileNameSection />);

    // Unchanged.
    expect(saveButton()).toBeDisabled();

    // Blank — this is what keeps the server's empty-name rejection unreachable.
    await userEvent.clear(nameInput());
    expect(saveButton()).toBeDisabled();

    // Whitespace-only trims to empty.
    await userEvent.type(nameInput(), '   ');
    expect(saveButton()).toBeDisabled();

    // A real change enables it.
    await userEvent.clear(nameInput());
    await userEvent.type(nameInput(), 'Ada B');
    expect(saveButton()).toBeEnabled();

    // Typing the persisted value back disables it again.
    await userEvent.clear(nameInput());
    await userEvent.type(nameInput(), 'Ada Lovelace');
    expect(saveButton()).toBeDisabled();
  });

  it('surfaces a failed save in place and leaves the field editable', async () => {
    tagAc(AC_GUARD);
    updateProfileApi.mockRejectedValue(new Error('Name must be 100 characters or fewer'));
    render(<ProfileNameSection />);

    await userEvent.clear(nameInput());
    await userEvent.type(nameInput(), 'Ada B');
    await userEvent.click(saveButton());

    expect(await screen.findByText(/100 characters or fewer/i)).toBeInTheDocument();
    expect(nameInput()).not.toBeDisabled();
    expect(nameInput()).toHaveValue('Ada B');
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('says nothing about historical attribution and asks for no confirmation', async () => {
    tagAc(AC_SILENT);
    render(<ProfileNameSection />);

    // dec-4: the user chose silence. This asserts that choice, so re-adding the
    // helper line is a deliberate reopening of dec-4, not a drive-by edit.
    expect(
      screen.queryByText(/previous name|old name|past activity|already recorded|history/i),
    ).toBeNull();

    await userEvent.clear(nameInput());
    await userEvent.type(nameInput(), 'Ada B');
    await userEvent.click(saveButton());

    // Commits on the first click — spec-479 D-2's no-confirm treatment.
    await waitFor(() => expect(updateProfileApi).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
