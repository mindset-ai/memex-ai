import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import type { ReactNode } from 'react';
import { CommentBubble, CommentMarkdown } from './CommentTray';
import type { Comment } from '../api/types';

// spec-484 t-2 / dec-2 — comment bodies render markdown (they are human- OR
// LLM-authored and legitimately contain markdown) while BOTH ref syntaxes stay
// linkified: full canonical paths (rehypeRefLinkifier) + the `[per dec-N]` /
// `[per t-N]` shorthand (rehypePerRefLinkifier). CommentBubble (the tray) and
// SectionCard's popover both render through the shared CommentMarkdown.

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-484/acs/ac-${n}`;

function makeComment(content: string, over: Partial<Comment> = {}): Comment {
  return {
    id: 'c-1',
    content,
    authorName: 'Alice',
    createdAt: new Date('2026-07-01T10:00:00Z').toISOString(),
    resolvedAt: null,
    resolution: null,
    docId: 'doc-1',
    ...over,
  } as Comment;
}

function renderBubble(content: string, over: Partial<Comment> = {}) {
  return render(
    <MemoryRouter>
      <CommentBubble comment={makeComment(content, over)} />
    </MemoryRouter>,
  );
}

function wrap(children: ReactNode) {
  return render(<MemoryRouter>{children}</MemoryRouter>);
}

describe('spec-484: CommentBubble renders markdown (ac-6)', () => {
  it('ac-6: **bold** renders <strong>, - list renders <li>, [x](/y) renders <a>', () => {
    tagAc(AC(6));
    const { container } = renderBubble('This is **bold**\n\n- one\n- two\n\nsee [docs](/y)');
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelectorAll('li')).toHaveLength(2);
    const link = container.querySelector('a[href="/y"]');
    expect(link?.textContent).toBe('docs');
    // No literal markdown syntax leaks through as text.
    expect(container.textContent).not.toContain('**bold**');
  });

  it('ac-6: SectionCard popover path (CommentMarkdown directly) renders markdown', () => {
    tagAc(AC(6));
    const { container } = wrap(
      <CommentMarkdown content={'**strong** and `code`'} className="text-secondary" />,
    );
    expect(container.querySelector('strong')?.textContent).toBe('strong');
    expect(container.querySelector('code')?.textContent).toBe('code');
  });
});

describe('spec-484: comment linkification survives the markdown path (ac-9)', () => {
  it('ac-9: [per dec-N] + a full canonical path + plain markdown all render, no mangling', () => {
    tagAc(AC(9));
    const { container } = renderBubble(
      'Per [per dec-3] and mindset-int/memex-app/specs/spec-3 — this is **important**.',
    );
    // Shorthand → interactive DecisionLink.
    expect(container.querySelector('[data-decision-handle="dec-3"]')).toBeInTheDocument();
    // Full canonical path → linkified anchor with the same-origin href.
    const canonical = container.querySelector('a[href="/mindset-int/memex-app/specs/spec-3"]');
    expect(canonical).toBeInTheDocument();
    expect(canonical?.textContent).toBe('mindset-int/memex-app/specs/spec-3');
    // Surrounding markdown still renders.
    expect(container.querySelector('strong')?.textContent).toBe('important');
    // Text is not double-processed / mangled — the prose words survive verbatim.
    expect(container.textContent).toContain('Per ');
    expect(container.textContent).toContain(' and ');
  });
});

describe('spec-484: parseEntityRefs loop is gone; refs route through markdown (ac-14)', () => {
  it('ac-14: [per dec-N] renders a DecisionLink through the markdown render path', () => {
    tagAc(AC(14));
    const { container } = renderBubble('Blocked per [per dec-7].');
    const link = container.querySelector('[data-testid="decision-link"]');
    expect(link).toBeInTheDocument();
    expect(link?.getAttribute('data-decision-handle')).toBe('dec-7');
  });

  it('ac-14: [per t-N] renders a TaskLink through the markdown render path', () => {
    tagAc(AC(14));
    const { container } = renderBubble('Waiting on [per t-4].');
    const link = container.querySelector('[data-testid="task-link"]');
    expect(link).toBeInTheDocument();
    expect(link?.getAttribute('data-task-handle')).toBe('t-4');
  });

  it('ac-14: shorthand inside inline code is NOT turned into a link', () => {
    tagAc(AC(14));
    const { container } = renderBubble('Type `[per dec-3]` verbatim.');
    expect(container.querySelector('[data-decision-handle]')).not.toBeInTheDocument();
    expect(container.querySelector('code')?.textContent).toBe('[per dec-3]');
  });
});
