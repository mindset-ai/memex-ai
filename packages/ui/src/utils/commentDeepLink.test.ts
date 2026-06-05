import { describe, it, expect } from 'vitest';
import {
  COMMENT_PARAM,
  commentHandle,
  commentAnchorId,
  parseCommentParam,
  buildCommentLink,
} from './commentDeepLink';
import { tagAc } from "@memex-ai-ac/vitest";

// spec-100 ac-6: a stable URL that links directly to a specific comment.
const AC_DEEPLINK = 'mindset-prod/memex-building-itself/specs/spec-100/acs/ac-6';

describe('commentDeepLink', () => {
  it('builds the canonical c-N handle and anchor id', () => {
    tagAc(AC_DEEPLINK);
    expect(commentHandle(42)).toBe('c-42');
    expect(commentAnchorId(42)).toBe('comment-c-42');
  });

  it('round-trips a link: build then parse recovers the seq', () => {
    tagAc(AC_DEEPLINK);
    const url = buildCommentLink('https://memex.ai/ns/mx/specs/spec-100', 7);
    expect(url).toContain(`${COMMENT_PARAM}=c-7`);
    const parsed = new URL(url).searchParams.get(COMMENT_PARAM);
    expect(parseCommentParam(parsed)).toBe(7);
  });

  it('preserves other query params when adding the comment param', () => {
    const url = buildCommentLink('https://memex.ai/ns/mx/specs/spec-100?tab=comments', 3);
    const sp = new URL(url).searchParams;
    expect(sp.get('tab')).toBe('comments');
    expect(sp.get(COMMENT_PARAM)).toBe('c-3');
  });

  it('parses valid handles and rejects junk', () => {
    expect(parseCommentParam('c-12')).toBe(12);
    expect(parseCommentParam(' c-5 ')).toBe(5);
    expect(parseCommentParam('c-0')).toBeNull();
    expect(parseCommentParam('dec-1')).toBeNull();
    expect(parseCommentParam('c-')).toBeNull();
    expect(parseCommentParam('c-abc')).toBeNull();
    expect(parseCommentParam(null)).toBeNull();
    expect(parseCommentParam(undefined)).toBeNull();
  });
});
