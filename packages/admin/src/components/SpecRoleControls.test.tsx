import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SpecRoleControls } from './SpecRoleControls';
import { tagAc } from '@memex-ai-ac/vitest';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-118/acs/ac-${n}`;

const fetchDocRole = vi.fn();
const fetchDocAssignees = vi.fn();
const assignUser = vi.fn();
const unassignUser = vi.fn();
const promoteToEditor = vi.fn();
const demoteToReviewer = vi.fn();
const listTeamMembersApi = vi.fn();

vi.mock('../api/client', () => ({
  fetchDocRole: (...a: unknown[]) => fetchDocRole(...a),
  fetchDocAssignees: (...a: unknown[]) => fetchDocAssignees(...a),
  assignUser: (...a: unknown[]) => assignUser(...a),
  unassignUser: (...a: unknown[]) => unassignUser(...a),
  promoteToEditor: (...a: unknown[]) => promoteToEditor(...a),
  demoteToReviewer: (...a: unknown[]) => demoteToReviewer(...a),
  listTeamMembersApi: (...a: unknown[]) => listTeamMembersApi(...a),
}));

vi.mock('../hooks/useMemexAccess', () => ({
  useMemexAccess: () => ({ canWrite: true }),
}));

vi.mock('./AuthContext', () => ({
  useAuth: () => ({ token: 'test-token' }),
}));

// useDocChangeStream opens a real EventSource — stub to keep the test hermetic.
vi.mock('../hooks/useDocChangeStream', () => ({
  useDocChangeStream: () => {},
}));

beforeEach(() => {
  vi.clearAllMocks();
  fetchDocAssignees.mockResolvedValue([]);
  assignUser.mockResolvedValue(undefined);
  unassignUser.mockResolvedValue(undefined);
  promoteToEditor.mockResolvedValue(undefined);
  demoteToReviewer.mockResolvedValue(undefined);
  listTeamMembersApi.mockResolvedValue([]);
});

describe('SpecRoleControls (spec-118 t-6)', () => {
  it('a reviewer sees "Switch to editing" and one click promotes them (no confirmation) (ac-15)', async () => {
    tagAc(AC(15));
    fetchDocRole.mockResolvedValueOnce({ editors: [], myRole: 'reviewer' });
    fetchDocRole.mockResolvedValue({ editors: [], myRole: 'editor' });

    render(<SpecRoleControls docId="d1" />);

    expect(await screen.findByTestId('spec-role-badge')).toHaveTextContent('Reviewer');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /switch to editing/i }));

    // One call, self-promote (no userId argument → server uses the session user).
    expect(promoteToEditor).toHaveBeenCalledWith('d1');
    await waitFor(() => expect(screen.getByTestId('spec-role-badge')).toHaveTextContent('Editor'));
  });

  it('an editor sees "Switch to reviewing" and one click demotes them (ac-16)', async () => {
    tagAc(AC(16));
    fetchDocRole.mockResolvedValueOnce({ editors: [], myRole: 'editor' });
    fetchDocRole.mockResolvedValue({ editors: [], myRole: 'reviewer' });

    render(<SpecRoleControls docId="d1" />);

    expect(await screen.findByTestId('spec-role-badge')).toHaveTextContent('Editor');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /switch to reviewing/i }));
    expect(demoteToReviewer).toHaveBeenCalledWith('d1');
  });

  it('shows the assign control: "Assign me" assigns, and an assignee can be unassigned (ac-12)', async () => {
    tagAc(AC(12));
    fetchDocRole.mockResolvedValue({ editors: [], myRole: 'reviewer' });
    // Start with one assignee so the unassign affordance renders.
    fetchDocAssignees.mockResolvedValue([
      { userId: 'u1', name: 'Alice', email: 'alice@x.com', assignedAt: '2026-01-01T00:00:00Z' },
    ]);

    render(<SpecRoleControls docId="d1" />);

    expect(await screen.findByTestId('spec-assign-control')).toBeInTheDocument();
    const user = userEvent.setup();

    // "Assign me" self-assigns (no userId → server uses session user).
    await user.click(screen.getByRole('button', { name: /assign me/i }));
    expect(assignUser).toHaveBeenCalledWith('d1');

    // The existing assignee can be removed.
    await user.click(screen.getByRole('button', { name: /unassign alice/i }));
    expect(unassignUser).toHaveBeenCalledWith('d1', 'u1');
  });

  it('the member picker assigns the chosen member via assignUser(docId, userId) (ac-12)', async () => {
    tagAc(AC(12));
    fetchDocRole.mockResolvedValue({ editors: [], myRole: 'reviewer' });
    fetchDocAssignees.mockResolvedValue([]);
    // The org roster the picker lists. Bob is the member we'll choose.
    listTeamMembersApi.mockResolvedValue([
      { userId: 'u-bob', email: 'bob@x.com', role: 'member', joinedAt: '2026-01-01T00:00:00Z' },
      { userId: 'u-carol', email: 'carol@x.com', role: 'member', joinedAt: '2026-01-01T00:00:00Z' },
    ]);

    render(<SpecRoleControls docId="d1" />);
    const user = userEvent.setup();

    // Open the picker; the roster loads lazily on first open.
    await user.click(await screen.findByRole('button', { name: /assign someone/i }));

    // Pick Bob → assignUser is called with the chosen user's id (not self).
    const bob = await screen.findByRole('option', { name: /bob@x\.com/i });
    await user.click(bob);
    expect(assignUser).toHaveBeenCalledWith('d1', 'u-bob');
  });
});
