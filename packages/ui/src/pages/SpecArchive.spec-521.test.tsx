// spec-521 t-4 (ac-5, ac-16) — the archive view, and the human-only boundary.
//
// ac-5 is a product commitment with three parts: there IS somewhere to see archived
// Specs, each row carries when/by whom/why, and you can restore from there. All three
// are asserted, plus the copy that makes the reason column worth having.
//
// ac-16 is the security-shaped half: archive and restore are HUMAN-ONLY. No agent
// surface gets either capability, in either direction (dec-6). On the web side that
// means the archive dialog and the archive view must not imply an agent could do this,
// and the restore path must be a real keyboard-reachable control rather than something
// the copy tells you to ask an agent for.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import { SpecArchive } from './SpecArchive';
import { ArchiveSpecDialog } from '../components/ArchiveSpecDialog';

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-521/acs/ac-${n}`;

const fetchArchivedDocs = vi.fn();
const restoreDoc = vi.fn();
const archiveDoc = vi.fn();

vi.mock('../api/client', () => ({
  fetchArchivedDocs: (...a: unknown[]) => fetchArchivedDocs(...a),
  restoreDoc: (...a: unknown[]) => restoreDoc(...a),
  archiveDoc: (...a: unknown[]) => archiveDoc(...a),
}));

vi.mock('../hooks/useDocChangeStream', () => ({
  useDocChangeStream: () => {},
}));

const ARCHIVED_ROW = {
  id: 'doc-1',
  handle: 'spec-245',
  title: 'Channel-aware footer projection',
  docType: 'spec',
  status: 'specify',
  createdAt: '2026-07-01T00:00:00.000Z',
  statusChangedAt: '2026-07-01T00:00:00.000Z',
  sectionCount: 3,
  archivedAt: '2026-07-30T10:00:00.000Z',
  archiveReason: 'absorbed into spec-510',
  archivedByName: 'Barrie',
};

beforeEach(() => {
  vi.clearAllMocks();
  fetchArchivedDocs.mockResolvedValue([ARCHIVED_ROW]);
  restoreDoc.mockResolvedValue(undefined);
  archiveDoc.mockResolvedValue(undefined);
});

function renderArchive() {
  return render(
    <MemoryRouter>
      <SpecArchive />
    </MemoryRouter>,
  );
}

describe('ac-5 — there is somewhere to see archived Specs, with when/by whom/why', () => {
  it('lists the archived Spec with its handle and title', async () => {
    tagAc(AC(5));
    renderArchive();
    expect(await screen.findByText(/Channel-aware footer projection/)).toBeInTheDocument();
    expect(screen.getByText('spec-245')).toBeInTheDocument();
  });

  it('shows WHEN it was archived', async () => {
    tagAc(AC(5));
    renderArchive();
    await screen.findByText(/Channel-aware footer projection/);
    // The row carries a rendered date, not a raw ISO string.
    const table = screen.getByRole('table');
    expect(table.textContent).not.toContain('2026-07-30T10:00:00.000Z');
    expect(table.textContent).toMatch(/2026/);
  });

  it('shows BY WHOM — the denormalised name stamped at write (std-32)', async () => {
    tagAc(AC(5));
    renderArchive();
    expect(await screen.findByText('Barrie')).toBeInTheDocument();
  });

  it('shows WHY — the load-bearing column', async () => {
    tagAc(AC(5));
    renderArchive();
    expect(await screen.findByText('absorbed into spec-510')).toBeInTheDocument();
  });

  it('shows the phase the Spec was in when archived', async () => {
    tagAc(AC(5));
    renderArchive();
    await screen.findByText(/Channel-aware footer projection/);
    expect(screen.getByRole('table').textContent).toContain('specify');
  });

  it('says so honestly when a legacy row has no recorded reason', async () => {
    tagAc(AC(5));
    fetchArchivedDocs.mockResolvedValue([
      { ...ARCHIVED_ROW, archiveReason: null, archivedByName: null },
    ]);
    renderArchive();
    expect(await screen.findByText('Not recorded')).toBeInTheDocument();
    expect(screen.getByRole('table').textContent).not.toContain('null');
  });

  it('RESTORES from the row, and the row leaves the list', async () => {
    tagAc(AC(5));
    renderArchive();
    const button = await screen.findByRole('button', {
      name: /Restore spec-245/,
    });
    await userEvent.click(button);
    await waitFor(() => expect(restoreDoc).toHaveBeenCalledWith('doc-1'));
    await waitFor(() =>
      expect(screen.queryByText(/Channel-aware footer projection/)).toBeNull(),
    );
  });

  it('Restore is a real button with an accessible name, reachable by keyboard', async () => {
    tagAc(AC(5));
    renderArchive();
    const button = await screen.findByRole('button', { name: /Restore spec-245/ });
    // A real <button> is tabbable by default; assert it is not a div-with-onClick.
    expect(button.tagName).toBe('BUTTON');
    await userEvent.tab();
    // Focus reaches an interactive element within the page (the Spec link or button).
    expect(document.activeElement).not.toBe(document.body);
  });

  it('surfaces a restore failure inline rather than losing it', async () => {
    tagAc(AC(5));
    restoreDoc.mockRejectedValue(new Error('Restore exploded'));
    renderArchive();
    await userEvent.click(await screen.findByRole('button', { name: /Restore spec-245/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Restore exploded');
  });

  it('has an honest empty state', async () => {
    tagAc(AC(5));
    fetchArchivedDocs.mockResolvedValue([]);
    renderArchive();
    expect(await screen.findByText(/Nothing archived/)).toBeInTheDocument();
  });

  it('the page explains that an archived Spec is withheld from Claude entirely', async () => {
    tagAc(AC(5));
    // ac-5 + the design intent: the old mental model was "archive tidies my board".
    // The page has to teach the new one, or the reason column has no stakes.
    renderArchive();
    await screen.findByText(/Channel-aware footer projection/);
    expect(screen.getByText(/will not read it at all/i)).toBeInTheDocument();
  });
});

describe('ac-16 — archive and restore are human-only, and the copy does not pretend otherwise', () => {
  it('the archive dialog asks WHY and states the real consequence', async () => {
    tagAc(AC(16));
    render(
      <MemoryRouter>
        <ArchiveSpecDialog docId="doc-1" title="Some Spec" onClose={() => {}} />
      </MemoryRouter>,
    );
    // The sentence that teaches the new model — "hidden from the board" is no longer
    // what archiving does.
    expect(
      screen.getByText(/Claude will stop reading this Spec entirely/),
    ).toBeInTheDocument();
    expect(screen.getByText(/You can restore it any time/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Reason/i)).toBeInTheDocument();
  });

  it('the archive dialog sends the reason the user typed', async () => {
    tagAc(AC(16));
    render(
      <MemoryRouter>
        <ArchiveSpecDialog docId="doc-1" title="Some Spec" onClose={() => {}} />
      </MemoryRouter>,
    );
    await userEvent.type(screen.getByLabelText(/Reason/i), 'premise gone');
    await userEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(archiveDoc).toHaveBeenCalledWith('doc-1', 'premise gone'));
  });

  it('the archive dialog caps the reason, matching the server', async () => {
    tagAc(AC(16));
    render(
      <MemoryRouter>
        <ArchiveSpecDialog docId="doc-1" title="Some Spec" onClose={() => {}} />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText(/Reason/i)).toHaveAttribute('maxLength', '280');
  });

  it('neither surface names an MCP tool or implies an agent could archive/restore', async () => {
    tagAc(AC(16));
    const { container: dialog } = render(
      <MemoryRouter>
        <ArchiveSpecDialog docId="doc-1" title="Some Spec" onClose={() => {}} />
      </MemoryRouter>,
    );
    renderArchive();
    await screen.findByText(/Channel-aware footer projection/);
    const text = `${dialog.textContent} ${document.body.textContent}`.toLowerCase();
    // std-34 cl-1/cl-3: no MCP vocabulary on a human surface.
    expect(text).not.toContain('mcp');
    expect(text).not.toContain('archive_doc');
    expect(text).not.toContain('restore_doc');
    expect(text).not.toContain('get_information');
    // dec-6/ac-16: nothing here suggests an agent can do this, in either direction.
    expect(text).not.toMatch(/ask (your |the )?(coding )?agent to (archive|restore)/);
    expect(text).not.toMatch(/claude can (archive|restore)/);
  });
});
