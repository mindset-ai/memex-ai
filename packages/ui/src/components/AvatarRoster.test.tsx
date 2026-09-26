import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';

// spec-574 — id-only surfaces (comments, Pulse) show a person's avatar choices from the
// team roster, and fall back to the automatic look whenever the roster is unavailable.
const SPEC = 'mindset-prod/memex-building-itself/specs/spec-574';
const AC_ROSTER = `${SPEC}/acs/ac-10`;
const AC_OTHERS_SEE = `${SPEC}/acs/ac-5`;

let authUser: Record<string, unknown> | null = null;
vi.mock('./AuthContext', () => ({
  useAuth: () => ({ token: 'test-token', user: authUser }),
}));

const listTeamMembersApi = vi.fn();
vi.mock('../api/client', () => ({
  listTeamMembersApi: (...a: unknown[]) => listTeamMembersApi(...a),
}));

import { AvatarRosterProvider } from './AvatarRoster';
import { CommentSourceAvatar } from './CommentSourceAvatar';

const AUTHOR_ID = 'author-1';

function comment() {
  return <CommentSourceAvatar source="human" authorName="Will Smith" authorUserId={AUTHOR_ID} />;
}
function shown() {
  return screen.getByTestId('avatar');
}

beforeEach(() => {
  authUser = { id: 'me', name: 'Me', email: 'me@example.com' };
  listTeamMembersApi.mockReset();
});

describe('AvatarRosterProvider', () => {
  it("shows a comment author's chosen letters and colour from the roster", async () => {
    tagAc(AC_ROSTER);
    tagAc(AC_OTHERS_SEE);
    listTeamMembersApi.mockResolvedValue([
      { userId: AUTHOR_ID, email: 'w@example.com', avatarLabel: 'WV', avatarColor: 'teal' },
    ]);
    render(<AvatarRosterProvider enabled tenantKey="acme/main">{comment()}</AvatarRosterProvider>);
    await waitFor(() => expect(shown().textContent).toBe('WV'));
    expect(shown().getAttribute('data-avatar-color')).toBe('teal');
  });

  it('falls back to the automatic look when the roster request fails', async () => {
    tagAc(AC_ROSTER);
    listTeamMembersApi.mockRejectedValue(new Error('boom'));
    render(<AvatarRosterProvider enabled tenantKey="acme/main">{comment()}</AvatarRosterProvider>);
    await waitFor(() => expect(listTeamMembersApi).toHaveBeenCalled());
    expect(shown().textContent).toBe('WS');
    expect(shown().getAttribute('data-avatar-color')).toBe('default');
  });

  it('tolerates a malformed roster payload', async () => {
    tagAc(AC_ROSTER);
    listTeamMembersApi.mockResolvedValue({ not: 'an array' });
    render(<AvatarRosterProvider enabled tenantKey="acme/main">{comment()}</AvatarRosterProvider>);
    await waitFor(() => expect(listTeamMembersApi).toHaveBeenCalled());
    expect(shown().textContent).toBe('WS');
  });

  it('makes no request when disabled (personal or public Memex), and shows the automatic look', () => {
    tagAc(AC_ROSTER);
    render(<AvatarRosterProvider enabled={false} tenantKey="acme/main">{comment()}</AvatarRosterProvider>);
    expect(listTeamMembersApi).not.toHaveBeenCalled();
    expect(shown().textContent).toBe('WS');
  });

  it('shows the automatic look with no provider at all', () => {
    tagAc(AC_ROSTER);
    render(comment());
    expect(listTeamMembersApi).not.toHaveBeenCalled();
    expect(shown().textContent).toBe('WS');
  });

  it("shows the signed-in user's own choices from their session, ahead of the roster", async () => {
    tagAc(AC_ROSTER);
    authUser = { id: AUTHOR_ID, name: 'Will Smith', email: 'w@example.com', avatarLabel: 'ME', avatarColor: 'red' };
    listTeamMembersApi.mockResolvedValue([
      { userId: AUTHOR_ID, email: 'w@example.com', avatarLabel: 'OLD', avatarColor: 'blue' },
    ]);
    render(<AvatarRosterProvider enabled tenantKey="acme/main">{comment()}</AvatarRosterProvider>);
    await waitFor(() => expect(listTeamMembersApi).toHaveBeenCalled());
    expect(shown().textContent).toBe('ME');
    expect(shown().getAttribute('data-avatar-color')).toBe('red');
  });

  it('refetches when the tenant changes', async () => {
    tagAc(AC_ROSTER);
    listTeamMembersApi.mockResolvedValue([]);
    const { rerender } = render(
      <AvatarRosterProvider enabled tenantKey="acme/main">{comment()}</AvatarRosterProvider>,
    );
    await waitFor(() => expect(listTeamMembersApi).toHaveBeenCalledTimes(1));
    rerender(<AvatarRosterProvider enabled tenantKey="acme/other">{comment()}</AvatarRosterProvider>);
    await waitFor(() => expect(listTeamMembersApi).toHaveBeenCalledTimes(2));
  });
});
