// spec-448 t-10 (ac-27): the version switcher's diff renders INLINE as an
// overlay on the narrative view (no separate route/page), reusing
// SectionCard's own markdown renderer for every section body.

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { DiffOverlay } from './DiffOverlay';
import { getVersionDiffData, type VersionDiffData } from '../api/docs';
import type { DocSection } from '../api/types';

const AC_INLINE_OVERLAY = 'mindset-prod/memex-building-itself/specs/spec-448/acs/ac-27';

vi.mock('../api/docs', async () => {
  const actual = await vi.importActual<typeof import('../api/docs')>('../api/docs');
  return {
    ...actual,
    getVersionDiffData: vi.fn(),
  };
});

function section(overrides: Partial<DocSection> & { seq: number }): DocSection {
  return {
    id: `sec-${overrides.seq}`,
    sectionType: 'overview',
    title: null,
    content: 'content',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function diffData(fromSections: DocSection[], toSections: DocSection[]): VersionDiffData {
  return {
    from: {
      version: 1,
      name: 'v1',
      createdAt: '2026-01-01T00:00:00.000Z',
      restoredFromVersion: null,
      checksum: 'a',
      snapshot: { sections: fromSections, decisions: [], acs: [], tasks: [], issues: [], comments: [] },
    },
    to: {
      version: 'primary',
      name: null,
      createdAt: null,
      restoredFromVersion: null,
      checksum: 'b',
      snapshot: { sections: toSections, decisions: [], acs: [], tasks: [], issues: [], comments: [] },
    },
  };
}

beforeEach(() => {
  vi.mocked(getVersionDiffData).mockReset();
});

describe('DiffOverlay', () => {
  it('fetches the diff for the given docId/from/to and renders it inline (ac-27)', async () => {
    tagAc(AC_INLINE_OVERLAY);
    const data = diffData(
      [section({ seq: 1, content: 'Old overview text.' })],
      [section({ seq: 1, content: 'New overview text.' })],
    );
    vi.mocked(getVersionDiffData).mockResolvedValue(data);

    render(<DiffOverlay docId="doc-1" from={1} to="primary" onClose={() => {}} />);

    expect(getVersionDiffData).toHaveBeenCalledWith('doc-1', 1, 'primary');
    // Rendered as an inline overlay (no route change involved) — the overlay
    // container itself is present in the DOM tree, portalled onto document.body.
    expect(screen.getByTestId('diff-overlay')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByTestId('diff-section')).toBeInTheDocument());
    expect(screen.getByText('edited')).toBeInTheDocument();
    // Reuses SectionCard's markdown renderer — both versions' text render as
    // normal prose within the overlay, not a bespoke diff-viewer widget.
    expect(screen.getByText('Old overview text.')).toBeInTheDocument();
    expect(screen.getByText('New overview text.')).toBeInTheDocument();
  });

  it('marks sections unique to one side as new / removed', async () => {
    tagAc(AC_INLINE_OVERLAY);
    const data = diffData(
      [section({ seq: 1, content: 'stays' }), section({ seq: 2, content: 'gone' })],
      [section({ seq: 1, content: 'stays' }), section({ seq: 3, content: 'fresh' })],
    );
    vi.mocked(getVersionDiffData).mockResolvedValue(data);

    render(<DiffOverlay docId="doc-1" from={1} to={2} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText('new section')).toBeInTheDocument());
    expect(screen.getByText('removed')).toBeInTheDocument();
    expect(screen.getByText('fresh')).toBeInTheDocument();
    expect(screen.getByText('gone')).toBeInTheDocument();
  });

  it('renders unchanged sections in full so the comparison reads as the document', async () => {
    const data = diffData(
      [section({ seq: 1, content: 'same text' })],
      [section({ seq: 1, content: 'same text' })],
    );
    vi.mocked(getVersionDiffData).mockResolvedValue(data);

    render(<DiffOverlay docId="doc-1" from={1} to={2} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByTestId('diff-section-unchanged')).toBeInTheDocument());
    // Unchanged sections render in full (not collapsed to a label), so the
    // comparison reads as the whole document with changes woven in.
    expect(screen.getByText('same text')).toBeInTheDocument();
    expect(screen.queryByTestId('diff-section')).not.toBeInTheDocument();
  });

  it('shows a load error when the diff fetch fails', async () => {
    vi.mocked(getVersionDiffData).mockRejectedValue(new Error('boom'));
    render(<DiffOverlay docId="doc-1" from={1} to={2} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
  });

  it('calls onClose when the close button is clicked', async () => {
    const data = diffData([section({ seq: 1, content: 'x' })], [section({ seq: 1, content: 'x' })]);
    vi.mocked(getVersionDiffData).mockResolvedValue(data);
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(<DiffOverlay docId="doc-1" from={1} to={2} onClose={onClose} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close diff' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Close diff' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
