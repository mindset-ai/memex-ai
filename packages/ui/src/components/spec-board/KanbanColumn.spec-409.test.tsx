// spec-409 (ac-1) — the board/Kanban card carries the compact "Code-grounded"
// marker so a reviewer scanning the board sees grounded / stale / not-grounded at
// a glance, without opening the Spec. Mirrors the page-header badge wiring; the
// marker stays absent for ungrounded specs (absence IS the signal).

import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import { KanbanColumn } from './KanbanColumn';
import type { DocSummary } from '../../api/types';

const AC1 = 'mindset-prod/memex-building-itself/specs/spec-409/acs/ac-1';

function summary(over: Partial<DocSummary> & Pick<DocSummary, 'id' | 'handle' | 'title'>): DocSummary {
  return {
    docType: 'spec',
    status: 'specify',
    parentDocId: null,
    createdAt: '2026-06-25T00:00:00.000Z',
    statusChangedAt: '2026-06-25T00:00:00.000Z',
    sectionCount: 0,
    archivedAt: null,
    ...over,
  } as DocSummary;
}

function renderColumn(docs: DocSummary[]) {
  return render(
    <MemoryRouter>
      <KanbanColumn
        id="specify"
        label="Specify"
        docs={docs}
        docsById={new Map(docs.map((d) => [d.id, d]))}
        isOver={false}
        draggingId={null}
        buildMenuItems={() => []}
        canWrite={false}
        onDragStart={() => {}}
        onDragEnd={() => {}}
        onDragOver={() => {}}
        onDragLeave={() => {}}
        onDrop={() => {}}
      />
    </MemoryRouter>,
  );
}

describe('KanbanColumn code-grounded card marker (spec-409 ac-1)', () => {
  it('renders the compact grounded marker on a grounded card', () => {
    tagAc(AC1);
    renderColumn([
      summary({
        id: 'g1',
        handle: 'spec-1',
        title: 'Grounded spec',
        groundedInCode: true,
        groundedByName: 'Barrie',
        groundedAt: '2026-06-25T00:00:00.000Z',
      }),
    ]);
    const badge = screen.getByTestId('code-grounded-badge');
    expect(badge).toHaveAttribute('data-state', 'grounded');
    // compact => glyph only, no text label
    expect(badge).not.toHaveTextContent(/code-grounded/i);
    expect(badge.getAttribute('title')).toContain('Barrie');
  });

  it('renders the stale state when the grounded spec has drifted', () => {
    tagAc(AC1);
    renderColumn([
      summary({
        id: 's1',
        handle: 'spec-2',
        title: 'Stale spec',
        groundedInCode: true,
        groundedStale: true,
      }),
    ]);
    expect(screen.getByTestId('code-grounded-badge')).toHaveAttribute('data-state', 'stale');
  });

  it('renders no marker on an ungrounded card', () => {
    tagAc(AC1);
    renderColumn([summary({ id: 'u1', handle: 'spec-3', title: 'Plain spec' })]);
    expect(screen.queryByTestId('code-grounded-badge')).toBeNull();
  });

  it('marks only the grounded cards when a column mixes both', () => {
    tagAc(AC1);
    renderColumn([
      summary({ id: 'g2', handle: 'spec-4', title: 'Grounded', groundedInCode: true }),
      summary({ id: 'u2', handle: 'spec-5', title: 'Ungrounded' }),
    ]);
    const badges = screen.getAllByTestId('code-grounded-badge');
    expect(badges).toHaveLength(1);
    // sanity: the grounded card's title is present alongside its badge
    expect(screen.getByText('Grounded')).toBeInTheDocument();
    expect(within(badges[0]).queryByText(/code-grounded/i)).toBeNull();
  });
});
