// spec-159: assignment lives on the byline; the SpecRoleControls row left the page.
//
// BylineAssignees ports the assignment behaviour from the old SpecRoleControls:
// chips load from fetchDocAssignees, a single "+ Assign" pill opens one dropdown
// ("Assign me" first, then the org roster minus already-assigned members), and
// chips carry a remove ✕ (gated on write access). These tests follow the same
// mocking idiom as SpecRoleControls.test.tsx.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BylineAssignees } from './BylineAssignees';

const fetchDocAssignees = vi.fn();
const assignUser = vi.fn();
const unassignUser = vi.fn();
const listTeamMembersApi = vi.fn();

vi.mock('../api/client', () => ({
  fetchDocAssignees: (...a: unknown[]) => fetchDocAssignees(...a),
  assignUser: (...a: unknown[]) => assignUser(...a),
  unassignUser: (...a: unknown[]) => unassignUser(...a),
  listTeamMembersApi: (...a: unknown[]) => listTeamMembersApi(...a),
}));

let mockCanWrite = true;
vi.mock('../hooks/useMemexAccess', () => ({
  useMemexAccess: () => ({ canWrite: mockCanWrite }),
}));

let mockUser: { id: string; email: string } | null = { id: 'u-me', email: 'me@x.com' };
vi.mock('./AuthContext', () => ({
  useAuth: () => ({ token: 'test-token', user: mockUser }),
}));

// useDocChangeStream opens a real EventSource — stub to keep the test hermetic.
vi.mock('../hooks/useDocChangeStream', () => ({
  useDocChangeStream: () => {},
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockCanWrite = true;
  mockUser = { id: 'u-me', email: 'me@x.com' };
  fetchDocAssignees.mockResolvedValue([]);
  assignUser.mockResolvedValue(undefined);
  unassignUser.mockResolvedValue(undefined);
  listTeamMembersApi.mockResolvedValue([]);
});

describe('BylineAssignees (spec-159)', () => {
  it('renders assignee chips from fetchDocAssignees', async () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-159/acs/ac-21');
    fetchDocAssignees.mockResolvedValue([
      { userId: 'u1', name: 'Alice', email: 'alice@x.com', assignedAt: '2026-01-01T00:00:00Z' },
    ]);

    render(<BylineAssignees docId="d1" />);

    expect(await screen.findByText('Alice')).toBeInTheDocument();
    expect(fetchDocAssignees).toHaveBeenCalledWith('d1');
  });

  it('unassigned + canWrite → just the "+ Assign" pill, no "Unassigned" text', async () => {
    fetchDocAssignees.mockResolvedValue([]);

    render(<BylineAssignees docId="d1" />);

    expect(await screen.findByRole('button', { name: /\+ assign/i })).toBeInTheDocument();
    expect(screen.queryByText(/unassigned/i)).not.toBeInTheDocument();
  });

  it('canWrite false → no pill; chips are read-only (no ✕)', async () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-159/acs/ac-21');
    mockCanWrite = false;
    fetchDocAssignees.mockResolvedValue([
      { userId: 'u1', name: 'Alice', email: 'alice@x.com', assignedAt: '2026-01-01T00:00:00Z' },
    ]);

    render(<BylineAssignees docId="d1" />);

    expect(await screen.findByText('Alice')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /\+ assign/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /unassign alice/i })).not.toBeInTheDocument();
  });

  it('canWrite false + unassigned → renders nothing', async () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-159/acs/ac-21');
    mockCanWrite = false;
    fetchDocAssignees.mockResolvedValue([]);

    const { container } = render(<BylineAssignees docId="d1" />);

    await waitFor(() => expect(fetchDocAssignees).toHaveBeenCalled());
    expect(screen.queryByTestId('byline-assignees')).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it('the picker opens with "Assign me" first, then the roster minus already-assigned', async () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-159/acs/ac-21');
    fetchDocAssignees.mockResolvedValue([
      { userId: 'u-bob', name: 'Bob', email: 'bob@x.com', assignedAt: '2026-01-01T00:00:00Z' },
    ]);
    listTeamMembersApi.mockResolvedValue([
      { userId: 'u-bob', email: 'bob@x.com', role: 'member', joinedAt: '2026-01-01T00:00:00Z' },
      { userId: 'u-carol', email: 'carol@x.com', role: 'member', joinedAt: '2026-01-01T00:00:00Z' },
    ]);

    render(<BylineAssignees docId="d1" />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /\+ assign/i }));

    // "Assign me" is the first option.
    const options = await screen.findAllByRole('option');
    expect(options[0]).toHaveTextContent(/assign me/i);
    // The already-assigned Bob is filtered out; Carol remains.
    expect(screen.getByRole('option', { name: /carol@x\.com/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /bob@x\.com/i })).not.toBeInTheDocument();
  });

  it('"Assign me" calls assignUser(docId) with no userId', async () => {
    fetchDocAssignees.mockResolvedValue([]);

    render(<BylineAssignees docId="d1" />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /\+ assign/i }));
    await user.click(screen.getByTestId('byline-assign-me'));

    expect(assignUser).toHaveBeenCalledWith('d1');
  });

  it('picking a roster member calls assignUser(docId, userId)', async () => {
    fetchDocAssignees.mockResolvedValue([]);
    listTeamMembersApi.mockResolvedValue([
      { userId: 'u-bob', email: 'bob@x.com', role: 'member', joinedAt: '2026-01-01T00:00:00Z' },
    ]);

    render(<BylineAssignees docId="d1" />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /\+ assign/i }));
    await user.click(await screen.findByRole('option', { name: /bob@x\.com/i }));

    expect(assignUser).toHaveBeenCalledWith('d1', 'u-bob');
  });

  it('a chip ✕ calls unassignUser(docId, userId)', async () => {
    fetchDocAssignees.mockResolvedValue([
      { userId: 'u1', name: 'Alice', email: 'alice@x.com', assignedAt: '2026-01-01T00:00:00Z' },
    ]);

    render(<BylineAssignees docId="d1" />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /unassign alice/i }));
    expect(unassignUser).toHaveBeenCalledWith('d1', 'u1');
  });

  it('hides "Assign me" when the session user is already assigned (matched by id)', async () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-159/acs/ac-21');
    fetchDocAssignees.mockResolvedValue([
      { userId: 'u-me', name: 'Me', email: 'me@x.com', assignedAt: '2026-01-01T00:00:00Z' },
    ]);

    render(<BylineAssignees docId="d1" />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /\+ assign/i }));
    expect(screen.queryByTestId('byline-assign-me')).not.toBeInTheDocument();
  });
});
