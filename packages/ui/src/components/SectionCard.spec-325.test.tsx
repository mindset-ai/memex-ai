// spec-325 — comments are read in situ. A SECTION-LEVEL comment (no span anchor)
// must render through the SAME spec-319 gutter surface span comments use, pinned
// to the TOP of the section body (dec-2, dec-4 / option c). And a comment
// deep-link emulates a click on that gutter card — pinning it on load (dec-1,
// dec-4 click-emulation).
//
//   ac-6 : a section-level comment renders a gutter indicator + peek/pin popover.
//   ac-7 : it sits at the section top; on collision with a top-of-body span
//          indicator the two stack with an offset.
//   ac-8 : a deep-link emulates the click — the target comment is pinned on load
//          (section-level: card at top, no passage highlight).
//   ac-4 : span-anchored indicators are unchanged (no regression).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SectionCard } from './SectionCard';
import type { DocSection, Comment } from '../api/types';
import { tagAc } from '@memex-ai-ac/vitest';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-325/acs/ac-${n}`;

vi.mock('./ChatContext', () => ({ useChat: () => ({ addContextChip: vi.fn() }) }));
vi.mock('./AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', name: 'Tester' } }) }));
vi.mock('../api/client', () => ({
  resolveComment: vi.fn().mockResolvedValue({}),
  deleteComment: vi.fn().mockResolvedValue(undefined),
  createComment: vi.fn().mockResolvedValue({}),
}));

// A span-anchored comment carries its end sentinel in the source; withRenderedMarkers
// turns it into the #marker-c-N anchor the indicator layer measures.
function endMarker(seq: number): string {
  return `anchor${seq}[^c-${seq}e]`;
}
function makeSection(over: Partial<DocSection> = {}): DocSection {
  return {
    id: 'sec-1',
    docId: 'doc-1',
    sectionType: 'overview',
    title: 'Overview',
    content: '# Heading\n\nMarkdown **body** here.',
    seq: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  } as DocSection;
}
function comment(over: Partial<Comment> & Pick<Comment, 'id' | 'seq'>): Comment {
  return {
    authorName: 'A',
    content: 'a comment',
    resolvedAt: null,
    anchorSnippet: null, // section-level by default
    createdAt: new Date().toISOString(),
    ...over,
  } as Comment;
}

beforeEach(() => vi.clearAllMocks());

describe('spec-325 — section-level comments render in the gutter (dec-2, dec-4)', () => {
  it('a section-level comment (no anchorSnippet, no body marker) renders a gutter indicator (ac-6)', () => {
    tagAc(AC(6));
    render(
      <SectionCard
        section={makeSection()}
        sectionNumber={1}
        commentCount={1}
        comments={[comment({ id: 'c1', seq: 1, content: 'on the whole section' })]}
      />,
    );
    // The section body has NO `[^c-1e]` marker, yet the indicator must still appear.
    expect(document.getElementById('indicator-c-1')).toBeInTheDocument();
  });

  it('clicking a section-level indicator pins a popover that shows the comment (ac-2, ac-6)', async () => {
    tagAc(AC(2)); // scope: a section-level comment is readable in the context of its section
    tagAc(AC(6));
    const user = userEvent.setup();
    render(
      <SectionCard
        section={makeSection()}
        sectionNumber={1}
        commentCount={1}
        comments={[comment({ id: 'c1', seq: 1, authorName: 'Wic', content: 'whole-section note' })]}
      />,
    );
    await user.click(document.getElementById('indicator-c-1')!);
    const pop = screen.getByTestId('comment-popover');
    expect(pop).toHaveAttribute('data-pinned', 'true');
    expect(within(pop).getByText('whole-section note')).toBeInTheDocument();
    expect(within(pop).getByText('Wic')).toBeInTheDocument();
  });

  it('positions a lone section-level indicator at the section top (ac-7)', () => {
    tagAc(AC(7));
    render(
      <SectionCard
        section={makeSection()}
        sectionNumber={1}
        commentCount={1}
        comments={[comment({ id: 'c1', seq: 1 })]}
      />,
    );
    const ind = document.getElementById('indicator-c-1') as HTMLElement;
    expect(ind.style.top).toBe('0px');
  });

  it('stacks a section-level indicator below a top-of-body span indicator on collision (ac-7)', () => {
    tagAc(AC(7));
    render(
      <SectionCard
        // span comment c-1 carries a marker (measured to top 0 in jsdom); c-2 is section-level.
        section={makeSection({ content: `Intro ${endMarker(1)} body.` })}
        sectionNumber={1}
        commentCount={2}
        comments={[
          comment({ id: 'c1', seq: 1, anchorSnippet: 'Intro', content: 'span one' }),
          comment({ id: 'c2', seq: 2, content: 'section-level two' }),
        ]}
      />,
    );
    const span = document.getElementById('indicator-c-1') as HTMLElement;
    const sectionLevel = document.getElementById('indicator-c-2') as HTMLElement;
    expect(span.style.top).toBe('0px');
    // The section-level indicator must NOT overlap the span indicator at top 0.
    expect(parseInt(sectionLevel.style.top, 10)).toBeGreaterThan(0);
  });

  it('does not regress span-only rendering: a span comment still renders its indicator (ac-4)', () => {
    tagAc(AC(4));
    render(
      <SectionCard
        section={makeSection({ content: `Intro ${endMarker(1)} body.` })}
        sectionNumber={1}
        commentCount={1}
        comments={[comment({ id: 'c1', seq: 1, anchorSnippet: 'Intro', content: 'span note' })]}
      />,
    );
    expect(document.getElementById('indicator-c-1')).toBeInTheDocument();
  });
});

describe('spec-325 — a deep-link emulates a click on the gutter card (dec-1, dec-4)', () => {
  it('pins the target section-level comment on load via deepLinkCommentSeq (ac-1, ac-3, ac-8)', async () => {
    tagAc(AC(1)); // scope: opened from a link, the comment is surfaced in situ on load
    tagAc(AC(3)); // scope: the comment's content is visible alongside its section, not stranded
    tagAc(AC(8));
    render(
      <SectionCard
        section={makeSection()}
        sectionNumber={1}
        commentCount={1}
        comments={[comment({ id: 'c1', seq: 1, content: 'deep-linked section note' })]}
        deepLinkCommentSeq={1}
      />,
    );
    // No click — the deep-link emulates one, so the card is pinned on load.
    await waitFor(() => {
      const pop = screen.getByTestId('comment-popover');
      expect(pop).toHaveAttribute('data-pinned', 'true');
      expect(within(pop).getByText('deep-linked section note')).toBeInTheDocument();
    });
  });

  it('pins the target span comment on load (ac-1, ac-3, ac-8)', async () => {
    tagAc(AC(1)); // scope: a span comment link also opens in situ on load
    tagAc(AC(3)); // scope: the anchored passage's comment content is visible alongside it
    tagAc(AC(8));
    render(
      <SectionCard
        section={makeSection({ content: `Intro ${endMarker(2)} body.` })}
        sectionNumber={1}
        commentCount={1}
        comments={[comment({ id: 'c2', seq: 2, anchorSnippet: 'Intro', content: 'deep-linked span note' })]}
        deepLinkCommentSeq={2}
      />,
    );
    await waitFor(() => {
      const pop = screen.getByTestId('comment-popover');
      expect(pop).toHaveAttribute('data-pinned', 'true');
      expect(within(pop).getByText('deep-linked span note')).toBeInTheDocument();
    });
  });

  it('does nothing when this section does not own the deep-linked comment', async () => {
    render(
      <SectionCard
        section={makeSection()}
        sectionNumber={1}
        commentCount={1}
        comments={[comment({ id: 'c1', seq: 1, content: 'not the target' })]}
        deepLinkCommentSeq={99}
      />,
    );
    // Give the pin effect a chance to (not) fire.
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('comment-popover')).not.toBeInTheDocument();
  });
});
