// spec-361 — comments render as always-expanded child rows under each segment in
// the SEGMENTS outline, marked with a comment icon, resolved ones struck through;
// the badge stays the UNRESOLVED count; clicking a child navigates in situ.
//
//   ac-1 : each section comment renders as a child row with the comment icon.
//   ac-2 : resolved comments render dimmed/struck-through, unresolved normally.
//   ac-3 : clicking a comment child triggers in-situ navigation (here: the
//          component contract — onCommentClick(seq, sectionId) fires).
//   ac-4 : comment children update live (re-render) without a remount.
//   ac-5 : comments only — no children for an empty segment, no decisions/tasks.
//   ac-6 : the segment badge = UNRESOLVED count, hidden when all resolved.
//   ac-7 : each child shows icon + snippet + author + a human-vs-agent indicator.
//   ac-8 : a resolved child's snippet is struck through; an open one is not.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { DocOutline } from './DocOutline';
import type { Comment, Doc, DocSection } from '../api/types';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-361/acs/ac-${n}`;

const doc = { id: 'doc-1' } as unknown as Doc;

function section(id: string, seq: number, title: string): DocSection {
  return { id, sectionType: 'overview', title, content: '', seq } as DocSection;
}

function comment(over: Partial<Comment>): Comment {
  return {
    id: over.id ?? `cid-${over.seq ?? 1}`,
    seq: over.seq,
    sectionId: over.sectionId ?? 's-2',
    decisionId: null,
    taskId: null,
    authorName: over.authorName ?? 'Barrie',
    content: over.content ?? 'a comment',
    resolution: null,
    resolvedAt: over.resolvedAt ?? null,
    createdAt: '2026-06-23T00:00:00Z',
    ...over,
  } as Comment;
}

const sections = [
  section('s-1', 1, 'Overview'),
  section('s-2', 2, 'Design & UX'),
  section('s-3', 3, 'Architecture'),
];

describe('spec-361 — comments as child nodes in the segment outline', () => {
  it('renders each section comment as a child row with the comment icon (ac-1)', () => {
    tagAc(AC(1));
    render(
      <DocOutline
        doc={doc}
        sections={sections}
        commentsBySection={{ 's-2': [comment({ seq: 1, content: 'tighten this' })] }}
      />,
    );
    const row = screen.getByRole('button', { name: /tighten this/ });
    expect(row).toBeInTheDocument();
    expect(row).toHaveTextContent('💬');
    expect(row).toHaveTextContent('tighten this');
  });

  it('renders no child rows for an empty segment, and only comments (ac-5)', () => {
    tagAc(AC(5));
    render(
      <DocOutline
        doc={doc}
        sections={sections}
        // s-2 has one comment; s-1 and s-3 have none.
        commentsBySection={{ 's-2': [comment({ seq: 1, content: 'only child' })] }}
      />,
    );
    // Exactly one comment child across the whole outline — no empty containers,
    // and decisions/tasks are never projected as children.
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(screen.getByRole('button', { name: /only child/ })).toBeInTheDocument();
  });

  it('resolved comments render struck-through, unresolved do not (ac-2, ac-8)', () => {
    tagAc(AC(2));
    tagAc(AC(8));
    render(
      <DocOutline
        doc={doc}
        sections={sections}
        commentsBySection={{
          's-2': [
            comment({ seq: 1, content: 'open one' }),
            comment({ seq: 2, content: 'done one', resolvedAt: '2026-06-23T01:00:00Z' }),
          ],
        }}
      />,
    );
    const openRow = screen.getByRole('button', { name: /open one/ });
    const doneRow = screen.getByRole('button', { name: /done one/ });
    expect(openRow).toHaveAttribute('data-resolved', 'false');
    expect(doneRow).toHaveAttribute('data-resolved', 'true');
    expect(within(doneRow).getByText('done one')).toHaveClass('line-through');
    expect(within(openRow).getByText('open one')).not.toHaveClass('line-through');
  });

  it('badge = UNRESOLVED count and is hidden when all are resolved, while resolved children still render (ac-6)', () => {
    tagAc(AC(6));
    render(
      <DocOutline
        doc={doc}
        sections={sections}
        // s-2 has 1 unresolved (badge 1) even though it has 2 total children;
        // s-1 has only a resolved comment → no badge but the child still shows.
        commentCounts={{ 's-2': 1 }}
        commentsBySection={{
          's-2': [
            comment({ seq: 1, content: 'open' }),
            comment({ seq: 2, content: 'closed', resolvedAt: '2026-06-23T01:00:00Z' }),
          ],
          's-1': [comment({ seq: 3, content: 'all done', resolvedAt: '2026-06-23T01:00:00Z' })],
        }}
      />,
    );
    // Badge for s-2 reads the unresolved count (1), NOT the child count (2).
    const s2 = screen.getByText('Design & UX').closest('a') as HTMLElement;
    expect(within(s2).getByText('1')).toBeInTheDocument();
    // s-1 has no unresolved comments → its row is just "1Overview", no badge,
    // yet its resolved comment renders as a child.
    const s1 = screen.getByText('Overview').closest('a') as HTMLElement;
    expect(s1.textContent).toBe('1Overview');
    expect(screen.getByRole('button', { name: /all done/ })).toHaveAttribute('data-resolved', 'true');
  });

  it('each child shows icon, snippet, author and a source indicator for human and agent (ac-7)', () => {
    tagAc(AC(7));
    render(
      <DocOutline
        doc={doc}
        sections={sections}
        commentsBySection={{
          's-2': [
            comment({ seq: 1, content: 'human note', authorName: 'Barrie', source: 'human' }),
            comment({ seq: 2, content: 'agent note', authorName: 'Memex', source: 'agent' }),
          ],
        }}
      />,
    );
    const humanRow = screen.getByRole('button', { name: /human note/ });
    const agentRow = screen.getByRole('button', { name: /agent note/ });
    // source indicator (data attribute, present for both branches)
    expect(humanRow).toHaveAttribute('data-source', 'human');
    expect(agentRow).toHaveAttribute('data-source', 'agent');
    // author shown on both; agent also gets a visible "AI" badge
    expect(humanRow).toHaveTextContent('Barrie');
    expect(agentRow).toHaveTextContent('Memex');
    expect(agentRow).toHaveTextContent('AI');
    expect(humanRow).not.toHaveTextContent('AI');
    // comment icon present
    expect(humanRow).toHaveTextContent('💬');
  });

  it('clicking a comment child invokes in-situ navigation with its seq + section (ac-3)', () => {
    tagAc(AC(3));
    const onCommentClick = vi.fn();
    render(
      <DocOutline
        doc={doc}
        sections={sections}
        onCommentClick={onCommentClick}
        commentsBySection={{ 's-2': [comment({ seq: 7, content: 'jump me' })] }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /jump me/ }));
    expect(onCommentClick).toHaveBeenCalledWith(7, 's-2');
  });

  it('new comments appear as children on re-render, no remount (ac-4)', () => {
    tagAc(AC(4));
    const { rerender } = render(
      <DocOutline
        doc={doc}
        sections={sections}
        commentsBySection={{ 's-2': [comment({ seq: 1, content: 'first' })] }}
      />,
    );
    expect(screen.getAllByRole('button')).toHaveLength(1);
    rerender(
      <DocOutline
        doc={doc}
        sections={sections}
        commentsBySection={{
          's-2': [comment({ seq: 1, content: 'first' }), comment({ seq: 2, content: 'second' })],
        }}
      />,
    );
    expect(screen.getByRole('button', { name: /second/ })).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });
});
