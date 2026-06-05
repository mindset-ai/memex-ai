import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CommentSourceAvatar } from './CommentSourceAvatar';

describe('CommentSourceAvatar', () => {
  it('renders the robot glyph for agent source', () => {
    render(<CommentSourceAvatar source="agent" authorName="claude-code" />);
    const avatar = screen.getByTestId('comment-source-avatar');
    expect(avatar.getAttribute('data-comment-source')).toBe('agent');
    // The robot emoji (🤖, U+1F916) is what we render for agent comments.
    expect(avatar.textContent).toContain('🤖');
    expect(avatar).toHaveAttribute('aria-label', 'Agent: claude-code');
  });

  it('renders initials for human source', () => {
    render(<CommentSourceAvatar source="human" authorName="Barrie Hadfield" />);
    const avatar = screen.getByTestId('comment-source-avatar');
    expect(avatar.getAttribute('data-comment-source')).toBe('human');
    expect(avatar.textContent).toBe('BH');
    expect(avatar).toHaveAttribute('aria-label', 'Human: Barrie Hadfield');
  });

  it('falls back to a single initial for single-word names', () => {
    render(<CommentSourceAvatar source="human" authorName="Alice" />);
    const avatar = screen.getByTestId('comment-source-avatar');
    expect(avatar.textContent).toBe('A');
  });

  it('treats undefined source as human', () => {
    render(<CommentSourceAvatar source={undefined} authorName="Pat" />);
    const avatar = screen.getByTestId('comment-source-avatar');
    expect(avatar.getAttribute('data-comment-source')).toBe('human');
  });

  it('renders "?" when given an empty author name', () => {
    render(<CommentSourceAvatar source="human" authorName="" />);
    const avatar = screen.getByTestId('comment-source-avatar');
    expect(avatar.textContent).toBe('?');
  });
});
