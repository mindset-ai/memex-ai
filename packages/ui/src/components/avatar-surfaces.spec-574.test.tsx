// spec-574 — other people see a person's chosen avatar on the Spec board card, the Spec
// byline's assignee chips and the assign picker. Each surface is mounted and driven the
// way a viewer meets it [per std-45].
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const SPEC = 'mindset-prod/memex-building-itself/specs/spec-574';
const AC_OTHERS_SEE = `${SPEC}/acs/ac-4`;
const AC_NOTHING_CHOSEN = `${SPEC}/acs/ac-6`;

const fetchDocAssignees = vi.fn();
const listTeamMembersApi = vi.fn();
vi.mock('../api/client', () => ({
  fetchDocAssignees: (...a: unknown[]) => fetchDocAssignees(...a),
  assignUser: vi.fn(),
  unassignUser: vi.fn(),
  listTeamMembersApi: (...a: unknown[]) => listTeamMembersApi(...a),
}));
vi.mock('../hooks/useMemexAccess', () => ({ useMemexAccess: () => ({ canWrite: true }) }));
vi.mock('./AuthContext', () => ({
  useAuth: () => ({ token: 'test-token', user: { id: 'u-me', email: 'me@x.com' } }),
}));
vi.mock('../hooks/useDocChangeStream', () => ({ useDocChangeStream: () => {} }));

import { BylineAssignees } from './BylineAssignees';
import { AssigneeAvatars } from './spec-board/AssigneeAvatars';

const CHOSEN = { userId: 'u1', name: 'Will Smith', email: 'will@x.com', avatarLabel: 'WV', avatarColor: 'teal' };
const PLAIN = { userId: 'u2', name: 'Wilma Iles', email: 'wilma@x.com', avatarLabel: null, avatarColor: null };

beforeEach(() => {
  vi.clearAllMocks();
  fetchDocAssignees.mockResolvedValue([]);
  listTeamMembersApi.mockResolvedValue([]);
});

function avatarsIn(el: HTMLElement) {
  return within(el).getAllByTestId('avatar');
}

describe('spec-574: the board card', () => {
  it("shows each assignee's chosen letters and colour, and the automatic look otherwise", () => {
    tagAc(AC_OTHERS_SEE);
    tagAc(AC_NOTHING_CHOSEN);
    render(<AssigneeAvatars assignees={[CHOSEN, PLAIN]} />);
    const [chosen, plain] = avatarsIn(screen.getByTestId('spec-assignees'));
    expect(chosen!.textContent).toBe('WV');
    expect(chosen!.getAttribute('data-avatar-color')).toBe('teal');
    expect(plain!.textContent).toBe('WI');
    expect(plain!.getAttribute('data-avatar-color')).toBe('default');
  });

  it('renders an assignee payload from an older server (no avatar fields) as before', () => {
    tagAc(AC_NOTHING_CHOSEN);
    render(<AssigneeAvatars assignees={[{ userId: 'u3', name: 'Sam', email: null }]} />);
    const [only] = avatarsIn(screen.getByTestId('spec-assignees'));
    expect(only!.textContent).toBe('SA');
  });
});

describe('spec-574: the Spec byline and assign picker', () => {
  it("shows an assignee chip with that person's chosen avatar", async () => {
    tagAc(AC_OTHERS_SEE);
    fetchDocAssignees.mockResolvedValue([{ ...CHOSEN, assignedAt: '2026-01-01T00:00:00Z' }]);
    render(<BylineAssignees docId="d1" />);
    await screen.findByText('Will Smith');
    const [chip] = avatarsIn(screen.getByTestId('byline-assignees'));
    expect(chip!.textContent).toBe('WV');
    expect(chip!.getAttribute('data-avatar-color')).toBe('teal');
  });

  it("shows each roster member's chosen avatar in the assign picker", async () => {
    tagAc(AC_OTHERS_SEE);
    listTeamMembersApi.mockResolvedValue([
      { ...CHOSEN, role: 'member', joinedAt: '2026-01-01T00:00:00Z' },
      { ...PLAIN, role: 'member', joinedAt: '2026-01-01T00:00:00Z' },
    ]);
    render(<BylineAssignees docId="d1" />);
    await userEvent.click(await screen.findByRole('button', { name: /\+ assign/i }));
    const willRow = await screen.findByRole('option', { name: /will@x\.com/ });
    const [willAvatar] = within(willRow).getAllByTestId('avatar');
    expect(willAvatar!.textContent).toBe('WV');
    expect(willAvatar!.getAttribute('data-avatar-color')).toBe('teal');
    const wilmaRow = screen.getByRole('option', { name: /wilma@x\.com/ });
    expect(within(wilmaRow).getByTestId('avatar').textContent).toBe('WI');
  });
});
