import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { tagAc } from '@memex-ai-ac/vitest';

// spec-574 t-4 — the profile page's Avatar section, mounted and driven the way a person
// uses it [per std-45]. The full-page journey (e2e) covers the no-reload repaint and
// persistence across a reload.
const SPEC = 'mindset-prod/memex-building-itself/specs/spec-574';
const AC_SET = `${SPEC}/acs/ac-1`;
const AC_CLEAR = `${SPEC}/acs/ac-2`;
const AC_REFUSED = `${SPEC}/acs/ac-3`;
const AC_COLOR = `${SPEC}/acs/ac-13`;

let user: Record<string, unknown>;
const updateSession = vi.fn();
vi.mock('./AuthContext', () => ({
  useAuth: () => ({ token: 'test-token', user, updateSession }),
}));

const updateAvatarApi = vi.fn();
vi.mock('../api/client', () => ({
  updateAvatarApi: (...a: unknown[]) => updateAvatarApi(...a),
}));

import { ProfileAvatarSection } from './ProfileAvatarSection';

const lettersInput = () => screen.getByTestId('profile-avatar-letters');
const saveButton = () => screen.getByTestId('profile-avatar-save');
const preview = () => screen.getByTestId('profile-avatar-preview').querySelector('[data-testid="avatar"]')!;

function sessionWith(fields: Record<string, unknown>) {
  return { user: { id: 'u1', name: 'Wren Marsh', email: 'wren@example.com', ...fields } };
}

beforeEach(() => {
  user = { id: 'u1', name: 'Wren Marsh', email: 'wren@example.com', avatarLabel: null, avatarColor: null };
  updateSession.mockReset();
  updateAvatarApi.mockReset();
  updateAvatarApi.mockImplementation(async (_t: string, fields: Record<string, unknown>) => sessionWith(fields));
});

describe('ProfileAvatarSection', () => {
  it('previews the automatic letters and default colour for someone who has chosen nothing', () => {
    tagAc(AC_COLOR);
    render(<ProfileAvatarSection />);
    expect(preview().textContent).toBe('WM');
    expect(preview().getAttribute('data-avatar-color')).toBe('default');
    expect(screen.getByRole('radio', { name: /default/i })).toHaveAttribute('aria-checked', 'true');
    expect(saveButton()).toBeDisabled();
  });

  it('sets letters: the preview follows typing, and Save sends them and adopts the session', async () => {
    tagAc(AC_SET);
    render(<ProfileAvatarSection />);
    await userEvent.type(lettersInput(), 'wv');
    expect(preview().textContent).toBe('WV');
    await userEvent.click(saveButton());
    await waitFor(() => expect(updateAvatarApi).toHaveBeenCalledTimes(1));
    expect(updateAvatarApi.mock.calls[0]).toEqual(['test-token', { avatarLabel: 'WV' }]);
    expect(updateSession).toHaveBeenCalledWith(sessionWith({ avatarLabel: 'WV' }));
    expect(await screen.findByText(/avatar saved/i)).toBeInTheDocument();
  });

  it('picks a colour from the picker and saves it', async () => {
    tagAc(AC_COLOR);
    render(<ProfileAvatarSection />);
    await userEvent.click(screen.getByRole('radio', { name: /teal/i }));
    expect(screen.getByRole('radio', { name: /teal/i })).toHaveAttribute('aria-checked', 'true');
    expect(preview().getAttribute('data-avatar-color')).toBe('teal');
    await userEvent.click(saveButton());
    await waitFor(() => expect(updateAvatarApi).toHaveBeenCalledTimes(1));
    expect(updateAvatarApi.mock.calls[0]).toEqual(['test-token', { avatarColor: 'teal' }]);
  });

  it('moves through the colour picker with the arrow keys', async () => {
    tagAc(AC_COLOR);
    render(<ProfileAvatarSection />);
    screen.getByRole('radio', { name: /default/i }).focus();
    await userEvent.keyboard('{ArrowRight}');
    const checked = screen.getAllByRole('radio').find((r) => r.getAttribute('aria-checked') === 'true')!;
    expect(checked).not.toBe(screen.getByRole('radio', { name: /default/i }));
    expect(checked).toHaveFocus();
  });

  it('goes back to the default colour', async () => {
    tagAc(AC_COLOR);
    user = { ...user, avatarColor: 'red' };
    render(<ProfileAvatarSection />);
    expect(preview().getAttribute('data-avatar-color')).toBe('red');
    await userEvent.click(screen.getByRole('radio', { name: /default/i }));
    await userEvent.click(saveButton());
    await waitFor(() => expect(updateAvatarApi).toHaveBeenCalledTimes(1));
    expect(updateAvatarApi.mock.calls[0]![1]).toEqual({ avatarColor: null });
  });

  it('clears chosen letters back to the automatic ones', async () => {
    tagAc(AC_CLEAR);
    user = { ...user, avatarLabel: 'WV' };
    render(<ProfileAvatarSection />);
    expect(lettersInput()).toHaveValue('WV');
    await userEvent.click(screen.getByRole('button', { name: /use automatic initials/i }));
    expect(lettersInput()).toHaveValue('');
    expect(preview().textContent).toBe('WM');
    await userEvent.click(saveButton());
    await waitFor(() => expect(updateAvatarApi).toHaveBeenCalledTimes(1));
    expect(updateAvatarApi.mock.calls[0]![1]).toEqual({ avatarLabel: null });
  });

  it.each([['a digit', 'W1'], ['a symbol', 'W!']])(
    'refuses %s inline, keeps Save disabled, and sends nothing',
    async (_label, typed) => {
      tagAc(AC_REFUSED);
      render(<ProfileAvatarSection />);
      await userEvent.type(lettersInput(), typed);
      expect(screen.getByText(/one or two letters/i, { selector: '[role="alert"]' })).toBeInTheDocument();
      expect(saveButton()).toBeDisabled();
      expect(updateAvatarApi).not.toHaveBeenCalled();
    },
  );

  it('caps the letters input at two characters', () => {
    tagAc(AC_REFUSED);
    render(<ProfileAvatarSection />);
    expect(lettersInput()).toHaveAttribute('maxLength', '2');
  });

  it('shows the server refusal verbatim and keeps the page usable', async () => {
    tagAc(AC_REFUSED);
    updateAvatarApi.mockRejectedValue(new Error('Avatar letters must be one or two letters (A–Z, including accented letters).'));
    render(<ProfileAvatarSection />);
    await userEvent.type(lettersInput(), 'ab');
    await userEvent.click(saveButton());
    expect(await screen.findByText(/must be one or two letters/i)).toBeInTheDocument();
    expect(updateSession).not.toHaveBeenCalled();
    expect(saveButton()).toBeEnabled();
  });

  it('renders for a session cached before avatar fields existed', () => {
    tagAc(AC_COLOR);
    user = { id: 'u1', name: 'Wren Marsh', email: 'wren@example.com' };
    render(<ProfileAvatarSection />);
    expect(preview().textContent).toBe('WM');
    expect(saveButton()).toBeDisabled();
  });
});

describe('ProfileAvatarSection: review round 1', () => {
  it('sends only what the person changed, so a choice made elsewhere is never wiped', async () => {
    tagAc(AC_SET);
    tagAc(AC_COLOR);
    // Stale cached session: the form opens showing nothing chosen.
    user = { ...user, avatarLabel: null, avatarColor: null };
    const { rerender } = render(<ProfileAvatarSection />);
    // The fresh session lands: letters "AB" were chosen on another device.
    user = { ...user, avatarLabel: 'AB', avatarColor: null };
    rerender(<ProfileAvatarSection />);
    // The untouched form catches up with what is saved.
    expect(lettersInput()).toHaveValue('AB');
    expect(preview().textContent).toBe('AB');

    await userEvent.click(screen.getByRole('radio', { name: /green/i }));
    await userEvent.click(saveButton());
    await waitFor(() => expect(updateAvatarApi).toHaveBeenCalledTimes(1));
    // Only the colour: the letters are not sent, so they cannot be cleared by accident.
    expect(updateAvatarApi.mock.calls[0]![1]).toEqual({ avatarColor: 'green' });
  });

  it('does not overwrite what the person is typing when a fresh session lands', async () => {
    tagAc(AC_SET);
    const { rerender } = render(<ProfileAvatarSection />);
    await userEvent.type(lettersInput(), 'wv');
    user = { ...user, avatarLabel: 'AB' };
    rerender(<ProfileAvatarSection />);
    expect(lettersInput()).toHaveValue('wv');
  });

  it('a colour since retired from the palette shows as Default and never blocks saving letters', async () => {
    tagAc(AC_COLOR);
    user = { ...user, avatarColor: 'chartreuse' };
    render(<ProfileAvatarSection />);
    expect(screen.getByRole('radio', { name: /default/i })).toHaveAttribute('aria-checked', 'true');
    await userEvent.type(lettersInput(), 'wv');
    await userEvent.click(saveButton());
    await waitFor(() => expect(updateAvatarApi).toHaveBeenCalledTimes(1));
    expect(updateAvatarApi.mock.calls[0]![1]).toEqual({ avatarLabel: 'WV' });
  });
});

describe('ProfileAvatarSection: accessible names (review round 1)', () => {
  it('names the letters field "Letters" only, not the button beside it', async () => {
    tagAc(AC_SET);
    user = { ...user, avatarLabel: 'WV' };
    render(<ProfileAvatarSection />);
    expect(screen.getByRole('textbox', { name: 'Letters' })).toBe(lettersInput());
  });
});

describe('ProfileAvatarSection: review round 2', () => {
  it('locks the controls while a save is in flight, so a mid-save change cannot be silently undone', async () => {
    tagAc(AC_COLOR);
    let resolveSave: (v: unknown) => void = () => {};
    updateAvatarApi.mockImplementation(() => new Promise((r) => (resolveSave = r)));
    user = { ...user, avatarLabel: 'AB' };
    render(<ProfileAvatarSection />);
    await userEvent.click(screen.getByRole('radio', { name: /green/i }));
    await userEvent.click(saveButton());
    expect(lettersInput()).toBeDisabled();
    // The clear button too: a mid-save clear would otherwise be undone by the saved "AB".
    expect(screen.getByRole('button', { name: /use automatic initials/i })).toBeDisabled();
    for (const swatch of screen.getAllByRole('radio')) expect(swatch).toBeDisabled();
    resolveSave(sessionWith({ avatarColor: 'green' }));
    await waitFor(() => expect(lettersInput()).toBeEnabled());
  });

  it('a saved label that fails today’s rule does not block saving a colour', async () => {
    tagAc(AC_COLOR);
    user = { ...user, avatarLabel: 'W1' };
    render(<ProfileAvatarSection />);
    await userEvent.click(screen.getByRole('radio', { name: /green/i }));
    expect(saveButton()).toBeEnabled();
    await userEvent.click(saveButton());
    await waitFor(() => expect(updateAvatarApi).toHaveBeenCalledTimes(1));
    expect(updateAvatarApi.mock.calls[0]![1]).toEqual({ avatarColor: 'green' });
  });
});
