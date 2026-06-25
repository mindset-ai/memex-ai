// Unit tests for the spec→markdown export helpers (spec-357 / sus-4 coverage
// uplift). UNTAGGED — pure-function rendering checks, no AC emission. These pin
// the markdown contract that DownloadMdDialog relies on: header, ordered
// sections, decisions, tasks (with ACs / blockers / section refs), and the
// three comment-inclusion modes.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { specToMarkdown, downloadMarkdown } from './specMarkdown';
import type { CommentMaps, MarkdownOptions } from './specMarkdown';
import type {
  Comment,
  Decision,
  DocSection,
  DocWithGraph,
  Task,
} from '../api/types';

function section(over: Partial<DocSection> = {}): DocSection {
  return {
    id: over.id ?? 'sec-1',
    sectionType: over.sectionType ?? 'overview',
    title: over.title ?? null,
    content: over.content ?? 'Section body.',
    seq: over.seq ?? 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function decision(over: Partial<Decision> = {}): Decision {
  return {
    id: over.id ?? 'dec-1',
    docId: 'doc-1',
    seq: over.seq ?? 1,
    title: over.title ?? 'Pick a database',
    context: over.context ?? null,
    status: over.status ?? 'open',
    resolution: over.resolution ?? null,
    resolvedAt: over.resolvedAt ?? null,
    createdAt: '2026-01-01T00:00:00Z',
    options: over.options ?? null,
    chosenOptionIndex: over.chosenOptionIndex ?? null,
  };
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: over.id ?? 'task-1',
    docId: 'doc-1',
    seq: over.seq ?? 1,
    title: over.title ?? 'Build the thing',
    description: over.description ?? '',
    acceptanceCriteria: over.acceptanceCriteria ?? [],
    sectionRef: over.sectionRef ?? null,
    status: over.status ?? 'not_started',
    blocked: over.blocked ?? false,
    blockedByDecisions: over.blockedByDecisions ?? [],
    blockedByTasks: over.blockedByTasks ?? [],
    createdAt: '2026-01-01T00:00:00Z',
    startedAt: null,
    completedAt: null,
  };
}

function comment(over: Partial<Comment> = {}): Comment {
  return {
    id: over.id ?? 'c-1',
    sectionId: over.sectionId ?? null,
    decisionId: over.decisionId ?? null,
    taskId: over.taskId ?? null,
    authorName: over.authorName ?? 'Alex',
    content: over.content ?? 'Looks good',
    resolution: over.resolution ?? null,
    resolvedAt: over.resolvedAt ?? null,
    createdAt: over.createdAt ?? '2026-03-15T12:00:00Z',
  };
}

function doc(over: Partial<DocWithGraph> = {}): DocWithGraph {
  return {
    id: 'doc-1',
    handle: over.handle ?? 'spec-1',
    title: over.title ?? 'My Spec',
    docType: over.docType ?? 'spec',
    status: over.status ?? 'draft',
    createdAt: '2026-01-01T00:00:00Z',
    statusChangedAt: '2026-01-01T00:00:00Z',
    sections: over.sections ?? [],
    decisions: over.decisions ?? [],
    tasks: over.tasks ?? [],
  };
}

const emptyComments: CommentMaps = { bySection: {}, byDecision: {}, byTask: {} };

const allOff: MarkdownOptions = {
  includeSections: false,
  includeDecisions: false,
  includeTasks: false,
  includeComments: false,
};

describe('specToMarkdown — header', () => {
  it('always renders the title + handle/type/status metadata', () => {
    const md = specToMarkdown(doc({ title: 'Auth Spec', handle: 'spec-9', status: 'build' }), emptyComments, allOff);
    expect(md).toContain('# Auth Spec');
    expect(md).toContain('- **Handle:** `spec-9`');
    expect(md).toContain('- **Type:** spec');
    expect(md).toContain('- **Status:** build');
    expect(md.endsWith('\n')).toBe(true);
  });

  it('omits sections/decisions/tasks/comments when all options are off', () => {
    const d = doc({
      sections: [section()],
      decisions: [decision()],
      tasks: [task()],
    });
    const md = specToMarkdown(d, emptyComments, allOff);
    expect(md).not.toContain('## Decisions');
    expect(md).not.toContain('## Tasks');
    expect(md).not.toContain('Section body.');
  });
});

describe('specToMarkdown — sections', () => {
  it('renders sections sorted by seq with numbered headings', () => {
    const d = doc({
      sections: [
        section({ id: 's2', seq: 2, title: 'Second', content: 'B' }),
        section({ id: 's1', seq: 1, title: 'First', content: 'A' }),
      ],
    });
    const md = specToMarkdown(d, emptyComments, { ...allOff, includeSections: true });
    expect(md).toContain('## 1. First');
    expect(md).toContain('## 2. Second');
    expect(md.indexOf('## 1. First')).toBeLessThan(md.indexOf('## 2. Second'));
  });

  it('falls back to a title-cased sectionType when title is null', () => {
    const d = doc({ sections: [section({ title: null, sectionType: 'design_ux' })] });
    const md = specToMarkdown(d, emptyComments, { ...allOff, includeSections: true });
    expect(md).toContain('## 1. Design Ux');
  });
});

describe('specToMarkdown — decisions', () => {
  it('renders an open decision with context and uppercased status', () => {
    const d = doc({
      decisions: [decision({ title: 'DB choice', context: '  weigh options  ', status: 'open' })],
    });
    const md = specToMarkdown(d, emptyComments, { ...allOff, includeDecisions: true });
    expect(md).toContain('## Decisions');
    expect(md).toContain('### D-1: DB choice — OPEN');
    expect(md).toContain('weigh options');
  });

  it('renders resolution only for resolved decisions that have one', () => {
    const d = doc({
      decisions: [
        decision({ seq: 1, status: 'resolved', resolution: 'Use Postgres' }),
        decision({ id: 'dec-2', seq: 2, status: 'resolved', resolution: null }),
        decision({ id: 'dec-3', seq: 3, status: 'open', resolution: 'ignored' }),
      ],
    });
    const md = specToMarkdown(d, emptyComments, { ...allOff, includeDecisions: true });
    expect(md).toContain('**Resolution:** Use Postgres');
    expect((md.match(/\*\*Resolution:\*\*/g) ?? []).length).toBe(1);
  });

  it('does not emit a Decisions section when there are none', () => {
    const md = specToMarkdown(doc({ decisions: [] }), emptyComments, {
      ...allOff,
      includeDecisions: true,
    });
    expect(md).not.toContain('## Decisions');
  });
});

describe('specToMarkdown — tasks', () => {
  it('renders status, blocked flag, description, ACs, blockers, and section ref', () => {
    const d = doc({
      tasks: [
        task({
          title: 'Wire auth',
          status: 'in_progress',
          blocked: true,
          description: '  do the work  ',
          acceptanceCriteria: [
            { description: 'login works', done: true },
            { description: 'logout works', done: false },
          ],
          blockedByDecisions: [decision({ seq: 5 })],
          blockedByTasks: [task({ id: 't9', seq: 9 })],
          sectionRef: 'sec-3',
        }),
      ],
    });
    const md = specToMarkdown(d, emptyComments, { ...allOff, includeTasks: true });
    expect(md).toContain('### T-1: Wire auth — in_progress (blocked)');
    expect(md).toContain('do the work');
    expect(md).toContain('**Acceptance criteria:**');
    expect(md).toContain('- [x] login works');
    expect(md).toContain('- [ ] logout works');
    expect(md).toContain('**Blocked by:** D-5, T-9');
    expect(md).toContain('**Section ref:** sec-3');
  });

  it('omits optional task blocks when empty and shows no "(blocked)" tag', () => {
    const d = doc({ tasks: [task({ title: 'Simple', status: 'complete' })] });
    const md = specToMarkdown(d, emptyComments, { ...allOff, includeTasks: true });
    expect(md).toContain('### T-1: Simple — complete');
    expect(md).not.toContain('(blocked)');
    expect(md).not.toContain('**Acceptance criteria:**');
    expect(md).not.toContain('**Blocked by:**');
    expect(md).not.toContain('**Section ref:**');
  });
});

describe('specToMarkdown — comments', () => {
  it('renders section comments when sections are included', () => {
    const d = doc({ sections: [section({ id: 's1', title: 'Overview' })] });
    const maps: CommentMaps = {
      bySection: { s1: [comment({ content: 'nice' })] },
      byDecision: {},
      byTask: {},
    };
    const md = specToMarkdown(d, maps, {
      includeSections: true,
      includeDecisions: false,
      includeTasks: false,
      includeComments: true,
    });
    expect(md).toContain('## Comments');
    expect(md).toContain('### On §1 Overview');
    expect(md).toContain('- **Alex** (2026-03-15): nice');
  });

  it('renders decision/task comments only when those primitives are NOT inlined', () => {
    const d = doc({
      decisions: [decision({ seq: 2, title: 'DBchoice' })],
      tasks: [task({ seq: 3, title: 'Ship' })],
    });
    const maps: CommentMaps = {
      bySection: {},
      byDecision: { 'dec-1': [comment({ id: 'cd', content: 'on dec' })] },
      byTask: { 'task-1': [comment({ id: 'ct', content: 'on task' })] },
    };
    // decisions & tasks NOT inlined -> their comments surface in the Comments group
    const md = specToMarkdown(d, maps, {
      includeSections: false,
      includeDecisions: false,
      includeTasks: false,
      includeComments: true,
    });
    expect(md).toContain('### On D-2: DBchoice');
    expect(md).toContain('### On T-3: Ship');
    expect(md).toContain('on dec');
    expect(md).toContain('on task');
  });

  it('renders resolved-comment markers and resolution text inline under a decision', () => {
    const d = doc({ decisions: [decision({ seq: 1, title: 'X' })] });
    const maps: CommentMaps = {
      bySection: {},
      byDecision: {
        'dec-1': [
          comment({
            content: 'fix this',
            resolvedAt: '2026-04-01T00:00:00Z',
            resolution: 'fixed it',
          }),
        ],
      },
      byTask: {},
    };
    const md = specToMarkdown(d, maps, {
      ...allOff,
      includeDecisions: true,
      includeComments: true,
    });
    // inlined under the decision because includeDecisions is true
    expect(md).toContain('[resolved]');
    expect(md).toContain('> Resolution: fixed it');
    // and NOT duplicated in a top-level Comments group
    expect(md).not.toContain('### On D-1');
  });

  it('produces no Comments section when there are no comments to show', () => {
    const d = doc({ sections: [section({ id: 's1' })] });
    const md = specToMarkdown(d, emptyComments, {
      includeSections: true,
      includeDecisions: false,
      includeTasks: false,
      includeComments: true,
    });
    expect(md).not.toContain('## Comments');
  });
});

describe('downloadMarkdown', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a blob URL, clicks an anchor with the filename, and revokes', () => {
    const createUrl = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:fake');
    const revokeUrl = vi
      .spyOn(URL, 'revokeObjectURL')
      .mockImplementation(() => {});
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});

    downloadMarkdown('spec-1.md', '# hi');

    expect(createUrl).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeUrl).toHaveBeenCalledWith('blob:fake');
    // anchor is removed again
    expect(document.querySelector('a[download="spec-1.md"]')).toBeNull();
  });
});
