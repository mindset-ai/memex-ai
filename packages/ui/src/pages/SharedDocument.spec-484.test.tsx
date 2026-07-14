// spec-484 t-1 (dec-1) — the shared-document comment body renders markdown.
//
//   ac-6 (partial) — a comment written with **bold** renders a <strong>, not literal
//                    asterisks (the body was previously plain whitespace-pre-wrap text).
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { CommentRow } from './SharedDocument';
import type { SharedCommentDto } from '../api/client';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-484/acs/ac-${n}`;

function makeComment(content: string): SharedCommentDto {
  return {
    id: 'c1',
    memexId: 'm1',
    sectionId: 's1',
    decisionId: null,
    taskId: null,
    authorName: 'Alex',
    authorUserId: 'u1',
    authorNamespaceId: 'm1',
    content,
    resolution: null,
    resolvedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('spec-484: SharedDocument comment body markdown', () => {
  it('ac-6: **bold** in a comment renders a <strong>, not literal asterisks', () => {
    tagAc(AC(6));
    const { container, queryByText } = render(
      <CommentRow comment={makeComment('this is **bold** text')} hostMemexId="m1" />,
    );
    const strong = container.querySelector('strong');
    expect(strong).not.toBeNull();
    expect(strong?.textContent).toBe('bold');
    // The raw markdown source must NOT survive as literal text.
    expect(queryByText(/\*\*bold\*\*/)).toBeNull();
  });
});
