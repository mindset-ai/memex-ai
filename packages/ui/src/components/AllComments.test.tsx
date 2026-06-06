import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AllComments } from './AllComments';
import type { DocSection, Decision, Task, Comment } from '../api/types';
import { tagAc } from "@memex-ai-ac/vitest";

const AC_FILTER_LOADBEARING = 'mindset-prod/memex-building-itself/specs/spec-100/acs/ac-9';
const AC_DEEPLINK = 'mindset-prod/memex-building-itself/specs/spec-100/acs/ac-6';
// spec-185 — remove the human comment-type filter chips.
const AC185 = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-185/acs/ac-${n}`;
// spec-194 — remove the author-kind (Everyone/System/People) filter row.
const AC194 = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-194/acs/ac-${n}`;

function makeComment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: 'c-1',
    sectionId: null,
    decisionId: null,
    taskId: null,
    authorName: 'Alice',
    content: 'A comment',
    resolution: null,
    resolvedAt: null,
    createdAt: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeSection(overrides: Partial<DocSection> = {}): DocSection {
  return {
    id: 'sec-1',
    sectionType: 'body',
    title: 'Introduction',
    content: 'Some text',
    seq: 1,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: 'dec-1',
    docId: 'doc-1',
    seq: 1,
    title: 'Use REST or gRPC?',
    context: null,
    status: 'open',
    resolution: null,
    resolvedAt: null,
    createdAt: '2025-01-01T00:00:00Z',
    options: null,
    chosenOptionIndex: null,
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    docId: 'doc-1',
    seq: 1,
    title: 'Implement auth',
    description: '',
    acceptanceCriteria: [],
    sectionRef: null,
    status: 'not_started',
    blocked: false,
    blockedByDecisions: [],
    blockedByTasks: [],
    createdAt: '2025-01-01T00:00:00Z',
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

describe('AllComments', () => {
  it('shows "No open comments" when all comment maps are empty', () => {
    render(
      <AllComments
        sections={[makeSection()]}
        commentsBySection={{}}
        onNavigateToSection={vi.fn()}
      />
    );

    expect(screen.getByText('No open comments.')).toBeInTheDocument();
  });

  it('aggregates unresolved comments from sections, decisions, and tasks', () => {
    const section = makeSection();
    const decision = makeDecision();
    const task = makeTask();

    render(
      <AllComments
        sections={[section]}
        decisions={[decision]}
        tasks={[task]}
        commentsBySection={{ [section.id]: [makeComment({ id: 'c-sec', content: 'section comment' })] }}
        commentsByDecision={{ [decision.id]: [makeComment({ id: 'c-dec', content: 'decision comment' })] }}
        commentsByTask={{ [task.id]: [makeComment({ id: 'c-task', content: 'task comment' })] }}
        onNavigateToSection={vi.fn()}
      />
    );

    expect(screen.getByText('section comment')).toBeInTheDocument();
    expect(screen.getByText('decision comment')).toBeInTheDocument();
    expect(screen.getByText('task comment')).toBeInTheDocument();
    expect(screen.queryByText('No open comments.')).not.toBeInTheDocument();
  });

  it('filters out resolved comments', () => {
    const section = makeSection();
    const resolved = makeComment({
      id: 'c-resolved',
      content: 'I am resolved',
      resolvedAt: '2025-06-01T00:00:00Z',
    });
    const open = makeComment({ id: 'c-open', content: 'I am open' });

    render(
      <AllComments
        sections={[section]}
        commentsBySection={{ [section.id]: [resolved, open] }}
        onNavigateToSection={vi.fn()}
      />
    );

    expect(screen.getByText('I am open')).toBeInTheDocument();
    expect(screen.queryByText('I am resolved')).not.toBeInTheDocument();
  });

  it('navigation callbacks fire with correct entity type/id', async () => {
    const user = userEvent.setup();
    const onNavigateToSection = vi.fn();
    const onTabChange = vi.fn();

    const section = makeSection({ id: 'sec-nav' });
    const decision = makeDecision({ id: 'dec-nav', seq: 2, title: 'Pick framework' });

    render(
      <AllComments
        sections={[section]}
        decisions={[decision]}
        commentsBySection={{ [section.id]: [makeComment({ id: 'c1' })] }}
        commentsByDecision={{ [decision.id]: [makeComment({ id: 'c2' })] }}
        onNavigateToSection={onNavigateToSection}
        onTabChange={onTabChange}
      />
    );

    // Click section header
    await user.click(screen.getByText(/Section 1/));
    expect(onNavigateToSection).toHaveBeenCalledWith('sec-nav');

    // Click decision header
    await user.click(screen.getByText(/Pick framework/));
    expect(onTabChange).toHaveBeenCalledWith('decisions');
  });

  // ── Comment-type filter chips removed (spec-185) ──

  it('renders no comment-type filter row even with open comments of mixed type (spec-185 ac-7)', () => {
    tagAc(AC185(7));
    tagAc(AC185(2)); // scope ac-2: doc-wide half of the symmetric removal (CommentTray tags ac-2 too)
    const section = makeSection();
    const decision = makeDecision();
    const task = makeTask();

    render(
      <AllComments
        sections={[section]}
        decisions={[decision]}
        tasks={[task]}
        commentsBySection={{
          [section.id]: [
            makeComment({ id: 'c-sec-plan', content: 'plan section', commentType: 'plan' }),
          ],
        }}
        commentsByDecision={{
          [decision.id]: [
            makeComment({ id: 'c-dec-q', content: 'decision question', commentType: 'question' }),
          ],
        }}
        commentsByTask={{
          [task.id]: [
            makeComment({ id: 'c-task-i', content: 'task issue', commentType: 'issue' }),
          ],
        }}
        onNavigateToSection={vi.fn()}
      />
    );

    // No comment-type chip row in the doc-wide view (consistent with CommentTray).
    expect(screen.queryByTestId('comment-filter-chips')).not.toBeInTheDocument();
    for (const chip of ['all', 'plan', 'progress', 'question', 'issue', 'drift']) {
      expect(screen.queryByTestId(`comment-filter-${chip}`)).not.toBeInTheDocument();
    }
    // ...and every comment renders regardless of type (no type narrowing).
    expect(screen.getByText('plan section')).toBeInTheDocument();
    expect(screen.getByText('decision question')).toBeInTheDocument();
    expect(screen.getByText('task issue')).toBeInTheDocument();
  });

  // ── spec-194 (dec-2): author-kind row restored (People→Humans), one combined row, distinct colour ──

  it('renders the author-kind row with Everyone/System/Humans — People renamed to Humans (spec-194 ac-5)', () => {
    tagAc(AC194(5));
    tagAc(AC194(8)); // ac-8: supersession withdrawn — the spec-100 author-filter test is re-added with the "Humans" label; restoration recorded in spec-100 + spec-185 comments
    const section = makeSection();
    render(
      <AllComments
        sections={[section]}
        commentsBySection={{
          [section.id]: [makeComment({ id: 'h', content: 'human note', source: 'human' })],
        }}
        onNavigateToSection={vi.fn()}
      />
    );
    expect(screen.getByTestId('author-filter')).toBeInTheDocument();
    for (const kind of ['all', 'system', 'human']) {
      expect(screen.getByTestId(`author-filter-${kind}`)).toBeInTheDocument();
    }
    // The human option reads "Humans", not "People".
    expect(screen.getByTestId('author-filter-human')).toHaveTextContent('Humans');
    expect(screen.queryByText('People')).not.toBeInTheDocument();
  });

  it('author-kind filtering narrows: System → agent only, Humans → human only (spec-194 ac-7)', async () => {
    tagAc(AC194(7));
    tagAc(AC194(3)); // scope ac-3: default (Everyone) shows human + agent together; author-kind narrowing is available, not forced
    tagAc(AC194(4)); // scope ac-4: narrowing reuses the shared filterComments predicate unchanged (System→agent, Humans→human)
    const user = userEvent.setup();
    const section = makeSection();
    render(
      <AllComments
        sections={[section]}
        commentsBySection={{
          [section.id]: [
            makeComment({ id: 'h', content: 'human note', source: 'human' }),
            makeComment({ id: 's', content: 'system flag', source: 'agent' }),
          ],
        }}
        onNavigateToSection={vi.fn()}
      />
    );
    // Default (Everyone): both visible.
    expect(screen.getByText('human note')).toBeInTheDocument();
    expect(screen.getByText('system flag')).toBeInTheDocument();
    // System → only agent-sourced.
    await user.click(screen.getByTestId('author-filter-system'));
    expect(screen.getByText('system flag')).toBeInTheDocument();
    expect(screen.queryByText('human note')).not.toBeInTheDocument();
    // Humans → only human-sourced.
    await user.click(screen.getByTestId('author-filter-human'));
    expect(screen.getByText('human note')).toBeInTheDocument();
    expect(screen.queryByText('system flag')).not.toBeInTheDocument();
  });

  it('renders author-kind + status chips on one combined row (spec-194 ac-9)', () => {
    tagAc(AC194(9));
    tagAc(AC194(1)); // scope ac-1: author-kind chips + status chips render together on one combined row
    const section = makeSection();
    render(
      <AllComments
        sections={[section]}
        commentsBySection={{ [section.id]: [makeComment({ id: 'h', content: 'human note' })] }}
        onNavigateToSection={vi.fn()}
      />
    );
    const author = screen.getByTestId('author-filter');
    const statusRow = screen.getByTestId('status-filter');
    // Same parent element → one combined row (author group, divider, status group).
    expect(author.parentElement).toBe(statusRow.parentElement);
  });

  it('author-kind chips carry the agent tone, status chips the accent tone (spec-194 ac-10)', () => {
    tagAc(AC194(10));
    const section = makeSection();
    render(
      <AllComments
        sections={[section]}
        commentsBySection={{ [section.id]: [makeComment({ id: 'h', content: 'human note' })] }}
        onNavigateToSection={vi.fn()}
      />
    );
    expect(screen.getByTestId('author-filter')).toHaveAttribute('data-tone', 'agent');
    expect(screen.getByTestId('status-filter')).toHaveAttribute('data-tone', 'accent');
  });

  it('surfaces resolved comments only when the Resolved status is selected', async () => {
    tagAc(AC_FILTER_LOADBEARING); // spec-100 ac-9 — status half retained
    tagAc(AC194(6)); // spec-194 ac-6: status filter still renders + works
    tagAc(AC185(5)); // scope ac-5: Open/Resolved/All state filter row unchanged by the chip removal
    tagAc(AC194(2)); // scope ac-2: Open/Resolved/All status row unchanged + still reaches resolved history
    const user = userEvent.setup();
    const section = makeSection();
    render(
      <AllComments
        sections={[section]}
        commentsBySection={{
          [section.id]: [
            makeComment({ id: 'o', content: 'open one' }),
            makeComment({ id: 'r', content: 'resolved one', resolvedAt: '2026-05-28T00:00:00Z' }),
          ],
        }}
        onNavigateToSection={vi.fn()}
      />
    );

    // Default status=open.
    expect(screen.getByText('open one')).toBeInTheDocument();
    expect(screen.queryByText('resolved one')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('status-filter-resolved'));
    expect(screen.getByText('resolved one')).toBeInTheDocument();
    expect(screen.queryByText('open one')).not.toBeInTheDocument();
  });

  // ── spec-100 ac-6: deep-link to a comment ──

  it('renders a stable scroll anchor (comment-c-{seq}) for each comment', () => {
    tagAc(AC_DEEPLINK);
    const section = makeSection();
    const { container } = render(
      <AllComments
        sections={[section]}
        commentsBySection={{ [section.id]: [makeComment({ id: 'x', seq: 42, content: 'anchored' })] }}
        onNavigateToSection={vi.fn()}
      />
    );
    expect(container.querySelector('#comment-c-42')).not.toBeNull();
  });

  it('copy-link button writes the c-N deep-link URL to the clipboard', async () => {
    tagAc(AC_DEEPLINK);
    const user = userEvent.setup();
    // Define AFTER setup(): userEvent installs its own clipboard stub on
    // navigator during setup, so ours must win at click time.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    const section = makeSection();
    render(
      <AllComments
        sections={[section]}
        commentsBySection={{ [section.id]: [makeComment({ id: 'x', seq: 7, content: 'copy me' })] }}
        onNavigateToSection={vi.fn()}
      />
    );

    await user.click(screen.getByTestId('comment-copy-link-7'));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain('comment=c-7');
  });
});
