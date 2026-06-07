import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { tagAc } from '@memex-ai-ac/vitest';
import { CommentTray } from './CommentTray';
import type { Comment } from '../api/types';

// spec-153 — remove the human comment-type dropdown.
const AC_NO_DROPDOWN =
  'mindset-prod/memex-building-itself/specs/spec-153/acs/ac-1';
const AC_POSTS_AS_DISCUSSION =
  'mindset-prod/memex-building-itself/specs/spec-153/acs/ac-2';
const AC_EXISTING_UNTOUCHED =
  'mindset-prod/memex-building-itself/specs/spec-153/acs/ac-4';
// spec-185 — remove the human comment-type filter chips.
const AC185 = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-185/acs/ac-${n}`;

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

  // ── Composer (spec-153: no human type picker) + comment-type chips removed (spec-185) + visual language ──

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

  it('renders no comment-type filter row — chips removed (spec-185 ac-6)', () => {
    tagAc(AC185(6));
    tagAc(AC185(1)); // scope ac-1: human tray renders no comment-type filter row at all
    tagAc(AC185(2)); // scope ac-2: tray half of the symmetric removal (AllComments tags ac-2 too)
    render(
      <CommentTray
        targetType="section"
        targetId="sec-1"
        comments={[comment({ id: 'c1', commentType: 'plan' })]}
      />
    );
    expect(screen.queryByTestId('comment-filter-chips')).not.toBeInTheDocument();
    for (const chip of ['all', 'plan', 'progress', 'question', 'issue', 'drift']) {
      expect(screen.queryByTestId(`comment-filter-${chip}`)).not.toBeInTheDocument();
    }
  });

  it('renders open comments of every type with no type filtering (spec-185 ac-8)', () => {
    tagAc(AC185(8));
    tagAc(AC185(4)); // scope ac-4: render-surface-only — no client-side type filtering remains, every type renders with comment_type intact
    const comments = [
      comment({ id: 'c-disc', content: 'a discussion', commentType: 'discussion' }),
      comment({ id: 'c-plan', content: 'a plan', commentType: 'plan' }),
      comment({ id: 'c-prog', content: 'a progress', commentType: 'progress' }),
      comment({ id: 'c-q', content: 'a question', commentType: 'question' }),
      comment({ id: 'c-issue', content: 'an issue', commentType: 'issue' }),
      comment({ id: 'c-drift', content: 'a drift', commentType: 'drift' }),
    ];
    render(
      <CommentTray targetType="section" targetId="sec-1" comments={comments} />
    );
    for (const body of ['a discussion', 'a plan', 'a progress', 'a question', 'an issue', 'a drift']) {
      expect(screen.getByText(body)).toBeInTheDocument();
    }
    expect(screen.getAllByTestId('comment-item')).toHaveLength(6);
  });

  it('renders the type pill and source avatar with the correct data-attributes', () => {
    // spec-153 ac-4: existing comments keep their per-type badges (the
    // "filter chips still work" half of ac-4 is superseded by spec-185, which
    // removed the chips). spec-185 ac-9: per-type pills survive the removal.
    tagAc(AC_EXISTING_UNTOUCHED);
    tagAc(AC185(9));
    tagAc(AC185(3)); // scope ac-3: per-type pills + agent/system comments render exactly as before
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

// spec-164 dec-6 — agent chatter (plan/progress) muted by default in trays
// that opt in (the task tray); human-loop types still auto-surface. spec-185
// removed the comment-type chips, so the chip-based reveal is gone (dec-2):
// muting-by-default is preserved and surfaced via the count note; spec-164
// ac-24's chip-reveal half and ac-25 (chip counts) are superseded — see the
// supersession comment on spec-164.
describe('CommentTray — muteAgentChatter (spec-164)', () => {
  const AC164 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-164/acs/ac-${n}`;

  const chatterSet = () => [
    comment({ id: 'c-prog', commentType: 'progress', content: 'agent progress update' } as Partial<Comment>),
    comment({ id: 'c-plan', commentType: 'plan', content: 'agent plan note' } as Partial<Comment>),
    comment({ id: 'c-rev', commentType: 'review', content: 'human review feedback' } as Partial<Comment>),
    comment({ id: 'c-q', commentType: 'question', content: 'human question' } as Partial<Comment>),
  ];

  it('hides plan/progress on the default view; review/question still render (spec-164 ac-9/ac-24; spec-185 ac-10/ac-11)', () => {
    // Muting-by-default survives the spec-185 chip removal (spec-185 ac-10);
    // the discoverability note names the count and no longer points at the
    // removed chips (spec-185 ac-11). spec-164 ac-24 keeps its muting half.
    tagAc(AC164(24));
    tagAc('mindset-prod/memex-building-itself/specs/spec-164/acs/ac-9');
    tagAc(AC185(10));
    tagAc(AC185(11));
    tagAc(AC185(12)); // ac-12: this rewritten spec-164 test (no chips) is the clean resolution — ac-9/ac-24 muting kept, note de-chipped; supersession recorded in spec-164 c-12
    render(
      <CommentTray targetType="task" targetId="t-1" comments={chatterSet()} muteAgentChatter />,
    );
    expect(screen.queryByText('agent progress update')).not.toBeInTheDocument();
    expect(screen.queryByText('agent plan note')).not.toBeInTheDocument();
    expect(screen.getByText('human review feedback')).toBeInTheDocument();
    expect(screen.getByText('human question')).toBeInTheDocument();
    const note = screen.getByTestId('comment-chatter-note');
    expect(note).toHaveTextContent('2 agent updates hidden');
    expect(note).not.toHaveTextContent(/chip/i);
    expect(note).not.toHaveTextContent(/Plan \/ Progress/);
  });

  it('without the opt-in (section/decision trays) chatter renders as before', () => {
    tagAc(AC164(24));
    render(<CommentTray targetType="section" targetId="s-1" comments={chatterSet()} />);
    expect(screen.getByText('agent progress update')).toBeInTheDocument();
    expect(screen.getByText('agent plan note')).toBeInTheDocument();
  });
});
