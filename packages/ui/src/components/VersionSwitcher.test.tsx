// spec-448 t-9 (ac-4, ac-5, ac-6, ac-26): the version switcher — lists every
// cut version + the live primary, and lets a user view-as-of, restore, or
// compare ANY two entries (including the primary), not just adjacent ones.

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { VersionSwitcher } from './VersionSwitcher';
import {
  listVersions,
  getVersionAsOf,
  rollbackVersion,
  getVersionDiffData,
  type VersionSummary,
  type DocumentVersionRow,
} from '../api/docs';

const AC_26 = 'mindset-prod/memex-building-itself/specs/spec-448/acs/ac-26';
const AC_4 = 'mindset-prod/memex-building-itself/specs/spec-448/acs/ac-4';
const AC_5 = 'mindset-prod/memex-building-itself/specs/spec-448/acs/ac-5';

vi.mock('../api/docs', async () => {
  const actual = await vi.importActual<typeof import('../api/docs')>('../api/docs');
  return {
    ...actual,
    listVersions: vi.fn(),
    getVersionAsOf: vi.fn(),
    rollbackVersion: vi.fn(),
    getVersionDiffData: vi.fn(),
  };
});

function summaries(): VersionSummary[] {
  return [
    { versionNumber: 1, name: 'Draft one', createdAt: '2026-06-01T00:00:00.000Z', actorName: 'Barrie', restoredFromVersion: null },
    { versionNumber: 2, name: 'Reviewed', createdAt: '2026-06-05T00:00:00.000Z', actorName: 'Ada', restoredFromVersion: null },
  ];
}

function versionRow(versionNumber: number, name: string): DocumentVersionRow {
  return {
    id: `ver-${versionNumber}`,
    memexId: 'mx-1',
    docId: 'doc-1',
    versionNumber,
    name,
    checksum: 'abc',
    snapshot: { sections: [], decisions: [], acs: [], tasks: [], issues: [], comments: [] },
    restoredFromVersion: null,
    actorUserId: 'u-1',
    actorName: 'Barrie',
    channel: 'rest_ui',
    createdAt: '2026-06-01T00:00:00.000Z',
  };
}

beforeEach(() => {
  vi.mocked(listVersions).mockReset().mockResolvedValue(summaries());
  vi.mocked(getVersionAsOf).mockReset();
  vi.mocked(rollbackVersion).mockReset();
  vi.mocked(getVersionDiffData).mockReset().mockResolvedValue({
    from: { version: 1, name: 'Draft one', createdAt: '2026-06-01T00:00:00.000Z', restoredFromVersion: null, checksum: 'a', snapshot: { sections: [], decisions: [], acs: [], tasks: [], issues: [], comments: [] } },
    to: { version: 'primary', name: null, createdAt: null, restoredFromVersion: null, checksum: 'b', snapshot: { sections: [], decisions: [], acs: [], tasks: [], issues: [], comments: [] } },
  });
});

describe('VersionSwitcher', () => {
  it('lists every cut version plus the live primary on open', async () => {
    const user = userEvent.setup();
    render(<VersionSwitcher docId="doc-1" currentVersion={3} onRestored={() => {}} />);

    await user.click(screen.getByTestId('version-switcher-trigger'));
    await waitFor(() => expect(screen.getAllByTestId('version-row')).toHaveLength(2));
    expect(screen.getByText(/V1 · Draft one/)).toBeInTheDocument();
    expect(screen.getByText(/V2 · Reviewed/)).toBeInTheDocument();
    expect(screen.getByTestId('version-row-primary')).toHaveTextContent('V3 · Current (working version)');
  });

  it('lets the user pick ANY two versions to compare, including the primary (ac-26)', async () => {
    tagAc(AC_26);
    const user = userEvent.setup();
    render(<VersionSwitcher docId="doc-1" currentVersion={3} onRestored={() => {}} />);

    await user.click(screen.getByTestId('version-switcher-trigger'));
    await waitFor(() => expect(screen.getAllByTestId('version-row')).toHaveLength(2));

    // Non-adjacent pair: V1 vs the live primary — not restricted to adjacent versions.
    await user.selectOptions(screen.getByTestId('compare-from-select'), '1');
    await user.selectOptions(screen.getByTestId('compare-to-select'), 'primary');
    await user.click(screen.getByRole('button', { name: /^compare$/i }));

    await waitFor(() => expect(getVersionDiffData).toHaveBeenCalledWith('doc-1', 1, 'primary'));
    expect(screen.getByTestId('diff-overlay')).toBeInTheDocument();
  });

  it('also allows comparing two concrete cut versions (not just vs primary) (ac-26)', async () => {
    tagAc(AC_26);
    const user = userEvent.setup();
    render(<VersionSwitcher docId="doc-1" currentVersion={3} onRestored={() => {}} />);

    await user.click(screen.getByTestId('version-switcher-trigger'));
    await waitFor(() => expect(screen.getAllByTestId('version-row')).toHaveLength(2));

    await user.selectOptions(screen.getByTestId('compare-from-select'), '1');
    await user.selectOptions(screen.getByTestId('compare-to-select'), '2');
    await user.click(screen.getByRole('button', { name: /^compare$/i }));

    await waitFor(() => expect(getVersionDiffData).toHaveBeenCalledWith('doc-1', 1, 2));
  });

  it('opens a read-only view-as-of a chosen version (ac-4)', async () => {
    tagAc(AC_4);
    vi.mocked(getVersionAsOf).mockResolvedValue(versionRow(1, 'Draft one'));
    const user = userEvent.setup();
    render(<VersionSwitcher docId="doc-1" currentVersion={3} onRestored={() => {}} />);

    await user.click(screen.getByTestId('version-switcher-trigger'));
    const row = (await screen.findAllByTestId('version-row'))[0];
    await user.click(within(row).getByRole('button', { name: /view/i }));

    expect(getVersionAsOf).toHaveBeenCalledWith('doc-1', 1);
    await waitFor(() => expect(screen.getByTestId('version-view-overlay')).toBeInTheDocument());
  });

  it('restores a prior version and calls onRestored (ac-5)', async () => {
    tagAc(AC_5);
    vi.mocked(rollbackVersion).mockResolvedValue(versionRow(3, 'Restored'));
    const onRestored = vi.fn();
    const user = userEvent.setup();
    render(<VersionSwitcher docId="doc-1" currentVersion={3} onRestored={onRestored} />);

    await user.click(screen.getByTestId('version-switcher-trigger'));
    const row = (await screen.findAllByTestId('version-row'))[0];
    await user.click(within(row).getByRole('button', { name: /restore/i }));

    const confirmDialog = await screen.findByTestId('restore-confirm');
    await user.click(within(confirmDialog).getByRole('button', { name: /^restore$/i }));

    await waitFor(() => expect(rollbackVersion).toHaveBeenCalledWith('doc-1', 1));
    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
  });

  it('hides the Restore action when canRestore is false, but keeps View available', async () => {
    const user = userEvent.setup();
    render(<VersionSwitcher docId="doc-1" currentVersion={3} onRestored={() => {}} canRestore={false} />);

    await user.click(screen.getByTestId('version-switcher-trigger'));
    const row = (await screen.findAllByTestId('version-row'))[0];
    expect(within(row).getByRole('button', { name: /view/i })).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /restore/i })).not.toBeInTheDocument();
  });
});
