import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SectionCard } from './SectionCard';
import type { DocSection, Comment } from '../api/types';

import { tagAc } from '@memex-ai-ac/vitest';
import { resolveComment, deleteComment } from '../api/client';

// ── spec-100 (redesign) ACs ──
const AC_INDICATORS = 'mindset-prod/memex-building-itself/specs/spec-100/acs/ac-12'; // edge indicators + peek/pin
const AC_RESOLVE_DELETE = 'mindset-prod/memex-building-itself/specs/spec-100/acs/ac-13';
const AC_SPRAWL = 'mindset-prod/memex-building-itself/specs/spec-100/acs/ac-14';
const USER_ID = 'user-tester-1';

const mockAddContextChip = vi.fn();
vi.mock('./ChatContext', () => ({
  useChat: () => ({ addContextChip: mockAddContextChip }),
}));

// SectionCard reads the current user (for delete-own ownership).
vi.mock('./AuthContext', () => ({
  useAuth: () => ({ user: { id: 'user-tester-1', name: 'Tester' } }),
}));

// Comment lifecycle hits the API; stub the client.
vi.mock('../api/client', () => ({
  resolveComment: vi.fn().mockResolvedValue({}),
  deleteComment: vi.fn().mockResolvedValue(undefined),
  createComment: vi.fn().mockResolvedValue({}),
}));

// An anchored comment renders its end sentinel `[^c-Ne]` in the section source;
// withRenderedMarkers turns it into the zero-width #marker-c-N anchor, which the
// indicator layer measures. So a section under test must carry the markers for
// its open comments, or no indicators appear.
function endMarkers(seqs: number[]): string {
  return seqs.map((s) => `anchor${s}[^c-${s}e]`).join(' ');
}
function makeSection(overrides: Partial<DocSection> = {}): DocSection {
  return {
    id: 'sec-1',
    docId: 'doc-1',
    sectionType: 'approach',
    title: 'Approach',
    content: '# Heading\n\nMarkdown **body**.',
    seq: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as DocSection;
}
function comment(over: Partial<Comment> & Pick<Comment, 'id' | 'seq'>): Comment {
  return {
    authorName: 'A',
    content: 'a comment',
    resolvedAt: null,
    createdAt: new Date().toISOString(),
    ...over,
  } as Comment;
}

beforeEach(() => vi.clearAllMocks());

describe('SectionCard', () => {
  // ── basic rendering ──

  it('renders the section title + number', () => {
    render(<SectionCard section={makeSection()} sectionNumber={3} />);
    const card = screen.getByTestId('section-card');
    expect(within(card).getByText('Approach')).toBeInTheDocument();
    expect(within(card).getByText('3')).toBeInTheDocument();
  });

  it('falls back to capitalized sectionType when title is empty', () => {
    render(
      <SectionCard
        section={makeSection({ title: '', sectionType: 'acceptance_criteria' })}
        sectionNumber={1}
      />
    );
    expect(screen.getByText('Acceptance Criteria')).toBeInTheDocument();
  });

  it('renders markdown content (headings + bold)', () => {
    render(<SectionCard section={makeSection()} sectionNumber={1} />);
    expect(screen.getByRole('heading', { level: 1, name: /Heading/i })).toBeInTheDocument();
    expect(screen.getByText('body')).toBeInTheDocument();
  });

  it('adds a context chip when the card body is clicked', async () => {
    const user = userEvent.setup();
    render(<SectionCard section={makeSection()} sectionNumber={2} />);
    await user.click(screen.getByText('Approach'));
    expect(mockAddContextChip).toHaveBeenCalledWith({
      type: 'section',
      id: 'sec-1',
      label: 'Section 2 — Approach',
    });
  });

  it('exposes the section id via data-section-id for scroll-to-element helpers', () => {
    render(<SectionCard section={makeSection({ id: 'sec-xyz' })} sectionNumber={1} />);
    expect(screen.getByTestId('section-card')).toHaveAttribute('data-section-id', 'sec-xyz');
  });

  // ── ac-12: right-edge indicators (no reserved gutter), open-only ──

  it('renders an edge indicator per OPEN anchored comment, not resolved ones', () => {
    tagAc(AC_INDICATORS);
    render(
      <SectionCard
        section={makeSection({ content: `Intro. ${endMarkers([1, 2])} Outro.` })}
        sectionNumber={1}
        commentCount={1}
        comments={[
          comment({ id: 'c1', seq: 1, content: 'open one' }),
          comment({ id: 'c2', seq: 2, content: 'resolved one', resolvedAt: new Date().toISOString() }),
        ]}
      />
    );
    expect(screen.getByTestId('section-body')).toBeInTheDocument();
    // Open comment → indicator; resolved comment → no indicator (and no marker).
    expect(document.getElementById('indicator-c-1')).toBeInTheDocument();
    expect(document.getElementById('indicator-c-2')).not.toBeInTheDocument();
    // No card is shown at rest (no reserved gutter / no expanded cards).
    expect(screen.queryByTestId('comment-popover')).not.toBeInTheDocument();
    expect(screen.getByTestId('section-comment-count')).toHaveTextContent('1');
  });

  it('shows no indicators and no gutter when the section has no comments', () => {
    render(<SectionCard section={makeSection()} sectionNumber={1} commentCount={0} comments={[]} />);
    expect(document.querySelectorAll('[data-indicator-seq]')).toHaveLength(0);
    expect(screen.queryByTestId('comment-popover')).not.toBeInTheDocument();
    expect(screen.queryByTestId('section-comment-count')).not.toBeInTheDocument();
  });

  // ── ac-12: hover peeks (read-only), click pins (actions) ──

  it('hovering an indicator peeks the comment read-only; clicking pins it with actions', async () => {
    tagAc(AC_INDICATORS);
    const user = userEvent.setup();
    render(
      <SectionCard
        section={makeSection({ content: `Intro. ${endMarkers([1])} Outro.` })}
        sectionNumber={1}
        commentCount={1}
        comments={[comment({ id: 'c1', seq: 1, authorName: 'Barrie', content: 'peek me' })]}
      />
    );
    const indicator = document.getElementById('indicator-c-1')!;

    // Hover → peek: content visible, but no action affordances.
    fireEvent.mouseEnter(indicator);
    const peek = screen.getByTestId('comment-popover');
    expect(within(peek).getByText('peek me')).toBeInTheDocument();
    expect(within(peek).getByText('Barrie')).toBeInTheDocument();
    expect(screen.queryByTestId('card-resolve-1')).not.toBeInTheDocument();
    expect(peek).toHaveAttribute('data-pinned', 'false');

    // Leave → peek closes.
    fireEvent.mouseLeave(indicator);
    expect(screen.queryByTestId('comment-popover')).not.toBeInTheDocument();

    // Click → pin: actions now present.
    await user.click(indicator);
    const pinned = screen.getByTestId('comment-popover');
    expect(pinned).toHaveAttribute('data-pinned', 'true');
    expect(within(pinned).getByTestId('card-resolve-1')).toBeInTheDocument();
  });

  it('a pinned card does not block peeking another comment', async () => {
    tagAc(AC_INDICATORS);
    const user = userEvent.setup();
    render(
      <SectionCard
        section={makeSection({ content: `Intro. ${endMarkers([1, 2])} Outro.` })}
        sectionNumber={1}
        commentCount={2}
        comments={[
          comment({ id: 'c1', seq: 1, content: 'first' }),
          comment({ id: 'c2', seq: 2, content: 'second' }),
        ]}
      />
    );
    await user.click(document.getElementById('indicator-c-1')!); // pin #1
    expect(screen.getByTestId('comment-popover')).toHaveAttribute('data-pinned', 'true');
    // Hover #2 → peek of #2 takes precedence (read-only), even though #1 is pinned.
    fireEvent.mouseEnter(document.getElementById('indicator-c-2')!);
    const pop = screen.getByTestId('comment-popover');
    expect(within(pop).getByText('second')).toBeInTheDocument();
    expect(pop).toHaveAttribute('data-pinned', 'false');
    // Leave → falls back to the pinned #1.
    fireEvent.mouseLeave(document.getElementById('indicator-c-2')!);
    expect(within(screen.getByTestId('comment-popover')).getByText('first')).toBeInTheDocument();
  });

  // ── ac-14: curb sprawl (show-more) + doc-wide collapse ──

  it('clamps a long comment behind "show more" and expands on click', async () => {
    tagAc(AC_SPRAWL);
    const user = userEvent.setup();
    const long = 'x'.repeat(400);
    render(
      <SectionCard
        section={makeSection({ content: `Intro. ${endMarkers([1])} Outro.` })}
        sectionNumber={1}
        commentCount={1}
        comments={[comment({ id: 'c1', seq: 1, content: long })]}
      />
    );
    await user.click(document.getElementById('indicator-c-1')!); // pin to reveal the card
    expect(screen.queryByText(long)).not.toBeInTheDocument(); // clamped
    const more = screen.getByTestId('card-showmore-1');
    await user.click(more);
    expect(screen.getByText(long)).toBeInTheDocument();
    expect(more).toHaveTextContent('Show less');
  });

  it('hides the edge indicators when collapsed doc-wide', () => {
    tagAc(AC_SPRAWL);
    const section = makeSection({ content: `Intro. ${endMarkers([1])} Outro.` });
    const comments = [comment({ id: 'c1', seq: 1, content: 'note' })];
    const { rerender } = render(
      <SectionCard section={section} sectionNumber={1} commentCount={1} comments={comments} />
    );
    expect(document.getElementById('indicator-c-1')).toBeInTheDocument();
    rerender(
      <SectionCard section={section} sectionNumber={1} commentCount={1} comments={comments} commentsCollapsed />
    );
    expect(document.getElementById('indicator-c-1')).not.toBeInTheDocument();
  });

  // ── ac-13: resolve + delete from the pinned card ──

  it('marks a comment done (resolve) from the pinned card and drops it', async () => {
    tagAc(AC_RESOLVE_DELETE);
    const user = userEvent.setup();
    const onCommentsChange = vi.fn();
    render(
      <SectionCard
        section={makeSection({ content: `Intro. ${endMarkers([1])} Outro.` })}
        sectionNumber={1}
        commentCount={1}
        comments={[comment({ id: 'c1', seq: 1, content: 'done me' })]}
        onCommentsChange={onCommentsChange}
      />
    );
    await user.click(document.getElementById('indicator-c-1')!); // pin
    await user.click(screen.getByTestId('card-resolve-1'));
    expect(vi.mocked(resolveComment)).toHaveBeenCalledWith('c1');
    expect(onCommentsChange).toHaveBeenCalledWith('sec-1', []);
  });

  it('shows Delete only on your own comment and deletes it with confirmation', async () => {
    tagAc(AC_RESOLVE_DELETE);
    const user = userEvent.setup();
    const onCommentsChange = vi.fn();
    render(
      <SectionCard
        section={makeSection({ content: `Intro. ${endMarkers([1, 2])} Outro.` })}
        sectionNumber={1}
        commentCount={2}
        comments={[
          comment({ id: 'mine', seq: 1, authorName: 'Me', content: 'mine', authorUserId: USER_ID }),
          comment({ id: 'theirs', seq: 2, authorName: 'Them', content: 'theirs', authorUserId: 'someone-else' }),
        ]}
        onCommentsChange={onCommentsChange}
      />
    );
    // Pin someone else's → no Delete.
    await user.click(document.getElementById('indicator-c-2')!);
    expect(screen.queryByTestId('card-delete-2')).not.toBeInTheDocument();

    // Pin my own → Delete present; first click confirms, cancel backs out.
    await user.click(document.getElementById('indicator-c-1')!);
    expect(screen.getByTestId('card-delete-1')).toBeInTheDocument();
    await user.click(screen.getByTestId('card-delete-1'));
    expect(vi.mocked(deleteComment)).not.toHaveBeenCalled();
    expect(screen.getByText('Delete forever?')).toBeInTheDocument();
    await user.click(screen.getByTestId('card-delete-cancel-1'));
    expect(screen.queryByText('Delete forever?')).not.toBeInTheDocument();
    // Confirm actually deletes.
    await user.click(screen.getByTestId('card-delete-1'));
    await user.click(screen.getByTestId('card-delete-confirm-1'));
    expect(vi.mocked(deleteComment)).toHaveBeenCalledWith('mine');
  });

  // ── ac-12: only one pinned card doc-wide (cross-section) ──

  it('pinning an indicator in another section closes the first section\'s pinned card', async () => {
    tagAc(AC_INDICATORS);
    const user = userEvent.setup();
    render(
      <>
        <SectionCard
          section={makeSection({ id: 'secA', content: `A. ${endMarkers([1])} end.` })}
          sectionNumber={1}
          commentCount={1}
          comments={[comment({ id: 'a1', seq: 1, content: 'alpha comment' })]}
        />
        <SectionCard
          section={makeSection({ id: 'secB', content: `B. ${endMarkers([1])} end.` })}
          sectionNumber={2}
          commentCount={1}
          comments={[comment({ id: 'b1', seq: 1, content: 'bravo comment' })]}
        />
      </>
    );
    const [indA, indB] = Array.from(document.querySelectorAll('#indicator-c-1')) as HTMLElement[];

    await user.click(indA);
    expect(screen.getByText('alpha comment')).toBeInTheDocument();

    await user.click(indB);
    // Exactly one pinned card doc-wide: B's, A's is gone.
    const popovers = screen.getAllByTestId('comment-popover');
    expect(popovers).toHaveLength(1);
    expect(screen.getByText('bravo comment')).toBeInTheDocument();
    expect(screen.queryByText('alpha comment')).not.toBeInTheDocument();
  });
});
