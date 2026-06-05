import { describe, it, expect } from 'vitest';
import type { Comment } from '../api/types';
import { filterComments, type CommentFilter, defaultCommentFilter } from './filterComments';
import { tagAc } from "@memex-ai-ac/vitest";

// spec-100 ac-9: the Comments tab's load-bearing filters are author kind
// (human vs system/agent) and status (open vs resolved, defaulting to open).
// Type is exposed but secondary. The four user-facing types are NOT redefined.
const AC_DEC3_FILTER = 'mindset-prod/memex-building-itself/specs/spec-100/acs/ac-9';

function c(overrides: Partial<Comment> = {}): Comment {
  return {
    id: Math.random().toString(36),
    sectionId: 's1',
    decisionId: null,
    taskId: null,
    authorName: 'X',
    content: '...',
    resolution: null,
    resolvedAt: null,
    createdAt: '2026-05-27T00:00:00Z',
    commentType: 'discussion',
    source: 'human',
    ...overrides,
  };
}

describe('filterComments — author kind', () => {
  it('filters to system (agent-sourced) comments', () => {
    tagAc(AC_DEC3_FILTER);
    const comments = [c({ source: 'human' }), c({ source: 'agent' })];
    const out = filterComments(comments, { authorKind: 'system', status: 'all', type: null });
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('agent');
  });

  it('filters to human comments (undefined source treated as human)', () => {
    const comments = [c({ source: 'human' }), c({ source: undefined }), c({ source: 'agent' })];
    const out = filterComments(comments, { authorKind: 'human', status: 'all', type: null });
    expect(out).toHaveLength(2);
  });

  it('authorKind=all keeps both', () => {
    const comments = [c({ source: 'human' }), c({ source: 'agent' })];
    expect(filterComments(comments, { authorKind: 'all', status: 'all', type: null })).toHaveLength(2);
  });
});

describe('filterComments — status (defaults to open)', () => {
  it('the default filter shows only open comments', () => {
    tagAc(AC_DEC3_FILTER);
    const comments = [c({ resolvedAt: null }), c({ resolvedAt: '2026-05-28T00:00:00Z' })];
    const out = filterComments(comments, defaultCommentFilter());
    expect(out).toHaveLength(1);
    expect(out[0].resolvedAt).toBeNull();
  });

  it('status=resolved shows only resolved', () => {
    const comments = [c({ resolvedAt: null }), c({ resolvedAt: '2026-05-28T00:00:00Z' })];
    const out = filterComments(comments, { authorKind: 'all', status: 'resolved', type: null });
    expect(out).toHaveLength(1);
    expect(out[0].resolvedAt).not.toBeNull();
  });

  it('status=all shows both', () => {
    const comments = [c({ resolvedAt: null }), c({ resolvedAt: '2026-05-28T00:00:00Z' })];
    expect(filterComments(comments, { authorKind: 'all', status: 'all', type: null })).toHaveLength(2);
  });
});

describe('filterComments — type (secondary)', () => {
  it('filters by an exact comment type', () => {
    const comments = [c({ commentType: 'issue' }), c({ commentType: 'discussion' })];
    const out = filterComments(comments, { authorKind: 'all', status: 'all', type: 'issue' });
    expect(out).toHaveLength(1);
    expect(out[0].commentType).toBe('issue');
  });

  it('type=null keeps all types', () => {
    const comments = [c({ commentType: 'issue' }), c({ commentType: 'review' })];
    expect(filterComments(comments, { authorKind: 'all', status: 'all', type: null })).toHaveLength(2);
  });
});

describe('filterComments — combined', () => {
  it('intersects author kind + status + type', () => {
    tagAc(AC_DEC3_FILTER);
    const comments = [
      c({ source: 'agent', resolvedAt: null, commentType: 'issue' }), // keep
      c({ source: 'agent', resolvedAt: '2026-05-28T00:00:00Z', commentType: 'issue' }), // resolved
      c({ source: 'human', resolvedAt: null, commentType: 'issue' }), // human
      c({ source: 'agent', resolvedAt: null, commentType: 'review' }), // wrong type
    ];
    const out = filterComments(comments, { authorKind: 'system', status: 'open', type: 'issue' });
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('agent');
  });
});

describe('defaultCommentFilter', () => {
  it('defaults to all authors, open status, no type — open is the load-bearing default', () => {
    const f: CommentFilter = defaultCommentFilter();
    expect(f).toEqual({ authorKind: 'all', status: 'open', type: null });
  });
});
