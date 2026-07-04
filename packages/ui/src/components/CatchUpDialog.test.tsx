// spec-448 t-11 (ac-9, ac-40, ac-41, ac-42): the catch-up-on-reopen dialog —
// unit tests for the standalone component. Page-level gating (WHEN it mounts:
// hasCatchUp true only, never for first-time/already-current viewers) is
// covered in DocDocument.spec-448.test.tsx; these tests exercise the dialog's
// own copy and its two actions once mounted.

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { CatchUpDialog } from './CatchUpDialog';
import { getVersionDiffData, type VersionDiffData, type VersionSummary } from '../api/docs';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-448/acs/ac-${n}`;

vi.mock('../api/docs', async () => {
  const actual = await vi.importActual<typeof import('../api/docs')>('../api/docs');
  return {
    ...actual,
    getVersionDiffData: vi.fn(),
  };
});

function versions(): VersionSummary[] {
  return [
    { versionNumber: 1, name: 'First cut', createdAt: '2026-06-01T00:00:00.000Z', actorName: 'Barrie', restoredFromVersion: null },
    { versionNumber: 2, name: 'Reviewed by legal', createdAt: '2026-06-05T00:00:00.000Z', actorName: 'Ada', restoredFromVersion: null },
    { versionNumber: 3, name: 'Post-launch tweaks', createdAt: '2026-06-10T00:00:00.000Z', actorName: 'Ada', restoredFromVersion: null },
  ];
}

function emptyDiff(): VersionDiffData {
  return {
    from: { version: 2, name: 'Reviewed by legal', createdAt: '2026-06-05T00:00:00.000Z', restoredFromVersion: null, checksum: 'a', snapshot: { sections: [], decisions: [], acs: [], tasks: [], issues: [], comments: [] } },
    to: { version: 'primary', name: null, createdAt: null, restoredFromVersion: null, checksum: 'b', snapshot: { sections: [], decisions: [], acs: [], tasks: [], issues: [], comments: [] } },
  };
}

beforeEach(() => {
  vi.mocked(getVersionDiffData).mockReset().mockResolvedValue(emptyDiff());
});

describe('CatchUpDialog', () => {
  it('names where the viewer was and where the spec is now (ac-9)', async () => {
    tagAc(AC(9));
    render(
      <CatchUpDialog
        docId="doc-1"
        fromVersion={2}
        currentVersion={4}
        versions={versions()}
        onDismiss={() => {}}
      />,
    );

    expect(await screen.findByTestId('catch-up-dialog')).toBeInTheDocument();
    // "where you were" — V2 · the name of the cut the viewer last saw.
    expect(screen.getByText(/V2 · Reviewed by legal/)).toBeInTheDocument();
    // "where the spec is now" — V4, using the most recent cut's (V3's) name,
    // mirroring the header badge's own resolution for the live working version.
    expect(screen.getByText(/V4 · Post-launch tweaks/)).toBeInTheDocument();
  });

  it('falls back to the bare "VN" form when a name can\'t be resolved', async () => {
    render(
      <CatchUpDialog docId="doc-1" fromVersion={2} currentVersion={3} versions={[]} onDismiss={() => {}} />,
    );
    const dialog = await screen.findByTestId('catch-up-dialog');
    expect(dialog).toHaveTextContent("You last saw V2 — it's now V3.");
  });

  it('"Just open it" dismisses to the current view with no extra API call (ac-42)', async () => {
    tagAc(AC(42));
    const onDismiss = vi.fn();
    const user = userEvent.setup();
    render(
      <CatchUpDialog docId="doc-1" fromVersion={2} currentVersion={4} versions={versions()} onDismiss={onDismiss} />,
    );

    await user.click(await screen.findByTestId('catch-up-just-open'));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(getVersionDiffData).not.toHaveBeenCalled();
  });

  it('Escape dismisses the same way as "Just open it"', async () => {
    const onDismiss = vi.fn();
    const user = userEvent.setup();
    render(
      <CatchUpDialog docId="doc-1" fromVersion={2} currentVersion={4} versions={versions()} onDismiss={onDismiss} />,
    );
    await screen.findByTestId('catch-up-dialog');
    await user.keyboard('{Escape}');
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('"Show me what changed" opens the diff anchored fromVersion ⇄ current (ac-42)', async () => {
    tagAc(AC(42));
    const user = userEvent.setup();
    render(
      <CatchUpDialog docId="doc-1" fromVersion={2} currentVersion={4} versions={versions()} onDismiss={() => {}} />,
    );

    await user.click(await screen.findByTestId('catch-up-show-changes'));

    await waitFor(() => expect(getVersionDiffData).toHaveBeenCalledWith('doc-1', 2, 'primary'));
    expect(await screen.findByTestId('diff-overlay')).toBeInTheDocument();
    expect(screen.queryByTestId('catch-up-dialog')).not.toBeInTheDocument();
  });

  it('closing the diff after "Show me what changed" dismisses the catch-up flow entirely', async () => {
    const onDismiss = vi.fn();
    const user = userEvent.setup();
    render(
      <CatchUpDialog docId="doc-1" fromVersion={2} currentVersion={4} versions={versions()} onDismiss={onDismiss} />,
    );

    await user.click(await screen.findByTestId('catch-up-show-changes'));
    await screen.findByTestId('diff-overlay');
    await user.click(screen.getByRole('button', { name: /close diff/i }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('catch-up-dialog')).not.toBeInTheDocument();
  });
});
