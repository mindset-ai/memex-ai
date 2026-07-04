// spec-448 t-8 (ac-1, ac-2): the create-version dialog — a required name plus
// the five carry-forward checkboxes (all checked by default), no "tools"
// checkbox, narrative always carries.

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { CreateVersionDialog } from './CreateVersionDialog';
import { createVersion, type DocumentVersionRow } from '../api/docs';

const AC_1 = 'mindset-prod/memex-building-itself/specs/spec-448/acs/ac-1';
const AC_2 = 'mindset-prod/memex-building-itself/specs/spec-448/acs/ac-2';

vi.mock('../api/docs', async () => {
  const actual = await vi.importActual<typeof import('../api/docs')>('../api/docs');
  return {
    ...actual,
    createVersion: vi.fn(),
  };
});

function versionRow(overrides: Partial<DocumentVersionRow> = {}): DocumentVersionRow {
  return {
    id: 'ver-1',
    memexId: 'mx-1',
    docId: 'doc-1',
    versionNumber: 1,
    name: 'v1',
    checksum: 'abc',
    snapshot: { sections: [], decisions: [], acs: [], tasks: [], issues: [], comments: [] },
    restoredFromVersion: null,
    actorUserId: 'u-1',
    actorName: 'Barrie',
    channel: 'rest_ui',
    createdAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(createVersion).mockReset();
});

describe('CreateVersionDialog', () => {
  it('renders 5 carry-forward checkboxes, all checked by default, and a required name field (ac-2)', () => {
    tagAc(AC_2);
    render(<CreateVersionDialog docId="doc-1" onClose={() => {}} onCreated={() => {}} />);

    for (const label of ['Decisions', 'Acceptance criteria', 'Tasks', 'Issues', 'Comments']) {
      // Anchored to the start of the accessible name — the label text leads,
      // but several descriptions mention other class names in passing (e.g.
      // "Comments"'s description ends in "...decisions, and tasks"), so an
      // unanchored match could hit the wrong checkbox.
      const checkbox = screen.getByRole('checkbox', { name: new RegExp(`^${label}\\b`) });
      expect(checkbox).toBeChecked();
    }
    expect(screen.getAllByRole('checkbox')).toHaveLength(5);
    // No "tools" checkbox — that class isn't part of the carry-forward vocabulary.
    expect(screen.queryByText(/tools/i)).not.toBeInTheDocument();

    const nameInput = screen.getByLabelText(/version name/i);
    expect(nameInput).toBeRequired();

    // Narrative always-carries is stated as helper copy, not a checkbox.
    expect(screen.getByText(/narrative sections always carry forward/i)).toBeInTheDocument();
  });

  it('the Create button is disabled until a name is entered (ac-1 UI half)', async () => {
    tagAc(AC_1);
    const user = userEvent.setup();
    render(<CreateVersionDialog docId="doc-1" onClose={() => {}} onCreated={() => {}} />);

    const submit = screen.getByRole('button', { name: /create version/i });
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText(/version name/i), 'Reviewed by legal');
    expect(submit).toBeEnabled();
  });

  it('unchecking a class passes a reduced carryForward to createVersion, and refetches on success (ac-1, ac-2)', async () => {
    tagAc(AC_1);
    tagAc(AC_2);
    vi.mocked(createVersion).mockResolvedValue(versionRow());
    const onCreated = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(<CreateVersionDialog docId="doc-42" onClose={onClose} onCreated={onCreated} />);

    await user.type(screen.getByLabelText(/version name/i), 'Sprint kickoff');
    await user.click(screen.getByRole('checkbox', { name: /^Tasks\b/ }));
    await user.click(screen.getByRole('button', { name: /create version/i }));

    await waitFor(() => expect(createVersion).toHaveBeenCalledTimes(1));
    expect(createVersion).toHaveBeenCalledWith('doc-42', {
      name: 'Sprint kickoff',
      carryForward: ['decisions', 'acs', 'issues', 'comments'],
    });
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows an error and keeps the dialog open when the create call fails', async () => {
    vi.mocked(createVersion).mockRejectedValue(new Error('name required'));
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(<CreateVersionDialog docId="doc-1" onClose={onClose} onCreated={() => {}} />);
    await user.type(screen.getByLabelText(/version name/i), 'x');
    await user.click(screen.getByRole('button', { name: /create version/i }));

    await waitFor(() => expect(screen.getByText('name required')).toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
  });
});
