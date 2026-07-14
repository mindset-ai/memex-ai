import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { DocOutline } from './DocOutline';
import type { Comment, Doc, DocSection } from '../api/types';

// spec-484 t-2 / dec-2 — the DocOutline comment child is a single-line,
// truncated PREVIEW. Unlike CommentTray/SectionCard bodies, it must STAY plain
// text (no markdown), so a `**bold**` preview reads as literal characters on one
// clamped line. This guards against the markdown treatment leaking here (ac-10).

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-484/acs/ac-${n}`;

const MARKDOWNY = '**bold** and `code` and - a list item';

function makeDoc(): Doc {
  return { id: 'd-1' } as Doc;
}
function makeSection(): DocSection {
  return { id: 's-1', sectionType: 'body', title: 'Intro' } as DocSection;
}
function makeComment(content: string): Comment {
  return {
    id: 'c-1',
    content,
    authorName: 'Alice',
    seq: 1,
    createdAt: new Date('2026-07-01T10:00:00Z').toISOString(),
    resolvedAt: null,
    resolution: null,
  } as Comment;
}

describe('spec-484: DocOutline comment preview stays plain (ac-10)', () => {
  it('ac-10: markdown-y comment content renders as literal text on a clamped line', () => {
    tagAc(AC(10));
    const { container } = render(
      <DocOutline
        doc={makeDoc()}
        sections={[makeSection()]}
        commentsBySection={{ 's-1': [makeComment(MARKDOWNY)] }}
      />,
    );
    // No markdown was rendered — the preview shows the raw characters.
    expect(container.querySelector('strong')).toBeNull();
    expect(container.querySelector('li')).toBeNull();
    // The content lives inside a single-line, truncated span verbatim.
    const clamped = container.querySelector('span.block.truncate');
    expect(clamped?.textContent).toBe(MARKDOWNY);
  });
});
