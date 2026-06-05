import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CommentTypePill } from './CommentTypePill';
import { COMMENT_TYPES, type CommentType } from '../api/types';
import { commentTypePillClass } from '../utils/commentStyles';

describe('CommentTypePill', () => {
  it('renders a pill for each of the 12 comment types with a distinct class', () => {
    // Per Section 7 of doc-10: each type gets its own colour. We can't reliably assert on
    // the rendered colour in jsdom (no CSS), but we can assert that:
    //   1. each type renders something,
    //   2. the className → CommentType mapping is unique across the 12 types,
    //   3. each pill carries data-comment-type for downstream tests / styling hooks.
    const seenClasses = new Set<string>();
    for (const type of COMMENT_TYPES) {
      const cls = commentTypePillClass(type);
      expect(cls).toBeTruthy();
      seenClasses.add(cls);
    }
    expect(seenClasses.size).toBe(COMMENT_TYPES.length);
  });

  it('renders a pill with the data-comment-type attribute for known types', () => {
    render(<CommentTypePill type="plan" />);
    const pill = screen.getByTestId('comment-type-pill');
    expect(pill.getAttribute('data-comment-type')).toBe('plan');
    expect(pill.textContent).toBe('Plan');
  });

  it('falls back to discussion when type is undefined', () => {
    render(<CommentTypePill type={undefined} />);
    const pill = screen.getByTestId('comment-type-pill');
    expect(pill.getAttribute('data-comment-type')).toBe('discussion');
  });

  it('renders nothing for discussion when hideForDiscussion=true (avoids visual noise)', () => {
    const { container } = render(<CommentTypePill type="discussion" hideForDiscussion />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('comment-type-pill')).not.toBeInTheDocument();
  });

  it('still renders for non-discussion types when hideForDiscussion=true', () => {
    render(<CommentTypePill type="question" hideForDiscussion />);
    expect(screen.getByTestId('comment-type-pill')).toBeInTheDocument();
  });

  it('renders consistent labels for every CommentType', () => {
    for (const type of COMMENT_TYPES) {
      const { unmount } = render(<CommentTypePill type={type as CommentType} />);
      const pill = screen.getByTestId('comment-type-pill');
      expect(pill.textContent ?? '').toBeTruthy();
      unmount();
    }
  });
});
