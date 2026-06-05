import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { tagAc } from '@memex-ai-ac/vitest';
import { CommentTray } from './CommentTray';
import type { Comment } from '../api/types';
import { FILTER_CHIP_TYPES } from '../utils/commentStyles';

// spec-153 — remove the human comment-type dropdown.
const AC_NO_DROPDOWN =
  'mindset-prod/memex-building-itself/specs/spec-153/acs/ac-1';
const AC_POSTS_AS_DISCUSSION =
  'mindset-prod/memex-building-itself/specs/spec-153/acs/ac-2';
const AC_EXISTING_UNTOUCHED =
  'mindset-prod/memex-building-itself/specs/spec-153/acs/ac-4';

const mockCreate = vi.fn();
const mockCreateDecision = vi.fn();
const mockCreateTask = vi.fn();
const mockResolve = vi.fn();
const mockUnresolve = vi.fn();

vi.mock('./AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-1', name: 'Tester' } }),
}));

vi.mock('../api/client', () => ({
  createComment: (...args: unknown[]) => mockCreate(...args),
  createDecisionComment: (...args: unknown[]) => mockCreateDecision(...args),
  createTaskComment: (...args: unknown[]) => mockCreateTask(...args),
  resolveComment: (...args: unknown[]) => mockResolve(...args),
  unresolveComment: (...args: unknown[]) => mockUnresolve(...args),
}));

function comment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: `c-${Math.random().toString(36).slice(2, 6)}`,
    authorName: 'Alice',
    content: 'Looks good',
    resolvedAt: null,
    createdAt: new Date('2026-04-01T10:00:00Z').toISOString(),
    ...overrides,
  } as Comment;
}

beforeEach(() => vi.clearAllMocks());

describe('CommentTray', () => {
  it('renders open comments and hides resolved behind a toggle', async () => {
    const user = userEvent.setup();
    const comments = [
      comment({ id: 'open-1', content: 'Open A' }),
      comment({
        id: 'resolved-1',
        content: 'Resolved B',
        resolvedAt: new Date().toISOString(),
      }),
    ];
    render(
      <CommentTray targetType="section" targetId="sec-1" comments={comments} />
    );

    // One open comment item visible; resolved is not yet.
    expect(screen.getAllByTestId('comment-item')).toHaveLength(1);
    expect(screen.getByText('Open A')).toBeInTheDocument();
    expect(screen.queryByText('Resolved B')).not.toBeInTheDocument();

    // Toggle to show resolved.
    await user.click(screen.getByRole('button', { name: /Show 1 resolved/i }));
    expect(screen.getByText('Resolved B')).toBeInTheDocument();
  });

  it('routes to the right create-* API per target type and appends the new comment', async () => {
    const user = userEvent.setup();
    const onCommentsChange = vi.fn();
    mockCreate.mockResolvedValue(comment({ id: 'new', content: 'Fresh take' }));

    render(
      <CommentTray
        targetType="section"
        targetId="sec-7"
        comments={[]}
        onCommentsChange={onCommentsChange}
      />
    );

    await user.type(screen.getByTestId('comment-textarea'), 'Fresh take');
    await user.click(screen.getByTestId('comment-submit'));

    expect(mockCreate).toHaveBeenCalledWith('sec-7', 'Tester', 'Fresh take', undefined);
    expect(onCommentsChange).toHaveBeenCalled();
    const callArgs = onCommentsChange.mock.calls[0];
    expect(callArgs[0]).toBe('sec-7');
    expect(callArgs[1][0].id).toBe('new');
  });

  it('dispatches to createDecisionComment for decision targets', async () => {
    const user = userEvent.setup();
    mockCreateDecision.mockResolvedValue(comment({ id: 'dc' }));
    render(
      <CommentTray targetType="decision" targetId="dec-1" comments={[]} />
    );
    await user.type(screen.getByTestId('comment-textarea'), 'on decision');
    await user.click(screen.getByTestId('comment-submit'));
    expect(mockCreateDecision).toHaveBeenCalledWith(
      'dec-1',
      'Tester',
      'on decision',
      undefined,
    );
  });

  it('dispatches to createTaskComment for task targets', async () => {
    const user = userEvent.setup();
    mockCreateTask.mockResolvedValue(comment({ id: 'tc' }));
    render(<CommentTray targetType="task" targetId="task-1" comments={[]} />);
    await user.type(screen.getByTestId('comment-textarea'), 'on task');
    await user.click(screen.getByTestId('comment-submit'));
    expect(mockCreateTask).toHaveBeenCalledWith(
      'task-1',
      'Tester',
      'on task',
      undefined,
    );
  });

  it('submit is disabled when the textarea is empty or only whitespace', async () => {
    const user = userEvent.setup();
    render(
      <CommentTray targetType="section" targetId="sec-1" comments={[]} />
    );

    const submit = screen.getByTestId('comment-submit');
    expect(submit).toBeDisabled();

    await user.type(screen.getByTestId('comment-textarea'), '   ');
    expect(submit).toBeDisabled();

    await user.type(screen.getByTestId('comment-textarea'), 'valid');
    expect(submit).toBeEnabled();
  });

  it('resolve button on an open comment calls resolveComment', async () => {
    const user = userEvent.setup();
    const onCommentsChange = vi.fn();
    const existing = comment({ id: 'c-1', content: 'Needs fix' });
    mockResolve.mockResolvedValue({
      ...existing,
      resolvedAt: new Date().toISOString(),
    });

    render(
      <CommentTray
        targetType="section"
        targetId="sec-1"
        comments={[existing]}
        onCommentsChange={onCommentsChange}
      />
    );

    const item = screen.getByTestId('comment-item');
    await user.click(within(item).getByRole('button', { name: /Resolve/i }));

    expect(mockResolve).toHaveBeenCalledWith('c-1');
    expect(onCommentsChange).toHaveBeenCalled();
  });

  // ── Composer (spec-153: no human type picker) + filter chips + visual language ──

  it('composer has no comment-type dropdown', () => {
    tagAc(AC_NO_DROPDOWN);
    render(<CommentTray targetType="section" targetId="sec-1" comments={[]} />);
    // The Discussion / Review / Issue / Question picker is gone — humans don't
    // classify their comments. Only the textarea + Post button remain.
    expect(screen.queryByTestId('comment-type-select')).not.toBeInTheDocument();
    expect(screen.getByTestId('comment-textarea')).toBeInTheDocument();
    expect(screen.getByTestId('comment-submit')).toBeInTheDocument();
  });

  it('posts a human comment as a freeform discussion (no type forwarded)', async () => {
    tagAc(AC_POSTS_AS_DISCUSSION);
    const user = userEvent.setup();
    mockCreate.mockResolvedValue(comment({ id: 'd1' }));
    render(<CommentTray targetType="section" targetId="sec-1" comments={[]} />);

    await user.type(screen.getByTestId('comment-textarea'), 'Just a thought');
    await user.click(screen.getByTestId('comment-submit'));

    // extras is undefined → server applies its REST default (source 'human', no
    // type → discussion). No human-chosen comment_type ever leaves the composer.
    expect(mockCreate).toHaveBeenCalledWith('sec-1', 'Tester', 'Just a thought', undefined);
  });

  it('renders the filter chip row with all six chip variants when comments are present', () => {
    tagAc(AC_EXISTING_UNTOUCHED);
    render(
      <CommentTray
        targetType="section"
        targetId="sec-1"
        comments={[comment({ id: 'c1' })]}
      />
    );
    // Reading/filtering by type is untouched by the composer change.
    expect(screen.getByTestId('comment-filter-chips')).toBeInTheDocument();
    expect(screen.getByTestId('comment-filter-all')).toBeInTheDocument();
    for (const t of FILTER_CHIP_TYPES) {
      expect(screen.getByTestId(`comment-filter-${t}`)).toBeInTheDocument();
    }
  });

  it('clicking a filter chip narrows the list and clicking again clears', async () => {
    const user = userEvent.setup();
    const planComment = comment({
      id: 'c-plan',
      content: 'plan body',
      commentType: 'plan',
    });
    const issueComment = comment({
      id: 'c-issue',
      content: 'issue body',
      commentType: 'issue',
    });

    render(
      <CommentTray
        targetType="section"
        targetId="sec-1"
        comments={[planComment, issueComment]}
      />
    );

    // Both visible at start.
    expect(screen.getByText('plan body')).toBeInTheDocument();
    expect(screen.getByText('issue body')).toBeInTheDocument();

    // Click the "plan" chip — only plan body shows.
    await user.click(screen.getByTestId('comment-filter-plan'));
    expect(screen.getByText('plan body')).toBeInTheDocument();
    expect(screen.queryByText('issue body')).not.toBeInTheDocument();

    // Click again to clear.
    await user.click(screen.getByTestId('comment-filter-plan'));
    expect(screen.getByText('plan body')).toBeInTheDocument();
    expect(screen.getByText('issue body')).toBeInTheDocument();
  });

  it('renders the type pill and source avatar with the correct data-attributes', () => {
    const agentPlan = comment({
      id: 'c-agent',
      content: 'agent plan body',
      commentType: 'plan',
      source: 'agent',
      authorName: 'Memex agent',
    });
    render(
      <CommentTray targetType="section" targetId="sec-1" comments={[agentPlan]} />
    );
    const item = screen.getByTestId('comment-item');
    const pill = within(item).getByTestId('comment-type-pill');
    expect(pill).toHaveAttribute('data-comment-type', 'plan');
    const avatar = within(item).getByTestId('comment-source-avatar');
    expect(avatar).toHaveAttribute('data-comment-source', 'agent');
  });

  it('hides the type pill for default-type (discussion) comments', () => {
    const discussion = comment({
      id: 'c-d',
      content: 'just chatting',
      commentType: 'discussion',
    });
    render(
      <CommentTray targetType="section" targetId="sec-1" comments={[discussion]} />
    );
    const item = screen.getByTestId('comment-item');
    expect(within(item).queryByTestId('comment-type-pill')).not.toBeInTheDocument();
  });
});
