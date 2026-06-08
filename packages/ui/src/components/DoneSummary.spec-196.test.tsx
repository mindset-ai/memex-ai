// spec-196 t-4 — "Read the spec" on the done view (dec-4).
//
// A done Spec's content was unreachable without reopening it (a phase change
// just to READ). DoneSummary now carries a "Read the spec" toggle beneath the
// Reopen area: every posture sees it, it's collapsed by default, and the
// expanded record renders the sorted narrative sections plus read-only
// decision/task/AC/issue detail — all from the props the page already passes
// (NOT the live panels, which fetch their own data).
//
//   ac-12 : any viewer reads the whole spec in place; no reopen, no phase change.
//   ac-13 : toggle below Reopen, all postures, collapsed default; expanded =
//           sections + decisions + tasks + ACs + issues from props.
//   ac-14 : zero network, zero mutation affordances, zero phase mutation.

import { render, screen, fireEvent, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { DoneSummary } from './DoneSummary';
import type { Decision, Task, Issue, DocWithGraph } from '../api/types';
import type { AcWithVerification } from '../api/client';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-196/acs/ac-${n}`;

const CREATED_AT = '2026-06-02T12:00:00Z';
const COMPLETED_AT = '2026-06-09T12:00:00Z';

function makeDoc(overrides: Partial<DocWithGraph> = {}): DocWithGraph {
  return {
    id: 'doc-uuid',
    handle: 'spec-196',
    title: 'Done view read control',
    docType: 'spec',
    status: 'done',
    creator: { name: 'Barrie Hadfield', email: 'barrie@mindset.ai' },
    createdAt: CREATED_AT,
    statusChangedAt: COMPLETED_AT,
    // Deliberately out of order — the read view must sort by seq.
    sections: [
      {
        id: 's-2',
        sectionType: 'design',
        title: 'Design & UX',
        content: 'The **second** section.',
        seq: 2,
        createdAt: CREATED_AT,
        updatedAt: COMPLETED_AT,
      },
      {
        id: 's-1',
        sectionType: 'overview',
        title: null,
        content: 'The *first* section.',
        seq: 1,
        createdAt: CREATED_AT,
        updatedAt: COMPLETED_AT,
      },
    ],
    decisions: [],
    tasks: [],
    ...overrides,
  } as DocWithGraph;
}

const DECISIONS: Decision[] = [
  {
    id: 'dec-1',
    docId: 'doc-uuid',
    seq: 1,
    title: 'Pick the approach',
    context: null,
    status: 'resolved',
    resolution: 'We picked the calm one.',
    resolvedAt: COMPLETED_AT,
    createdAt: CREATED_AT,
    options: null,
    chosenOptionIndex: null,
  },
];

const TASKS: Task[] = [
  {
    id: 't-1',
    docId: 'doc-uuid',
    seq: 1,
    title: 'Ship the thing',
    description: '',
    acceptanceCriteria: [],
    sectionRef: null,
    status: 'complete',
    blocked: false,
    blockedByDecisions: [],
    blockedByTasks: [],
    createdAt: CREATED_AT,
    startedAt: null,
    completedAt: COMPLETED_AT,
  },
];

const ACS: AcWithVerification[] = [
  {
    ac: {
      id: 'ac-1',
      memexId: 'memex',
      briefId: 'doc-uuid',
      seq: 1,
      kind: 'scope',
      statement: 'The thing ships',
      status: 'active',
      createdAt: CREATED_AT,
      updatedAt: COMPLETED_AT,
    },
    canonicalRef: 'x/y/specs/spec-196/acs/ac-1',
    tests: [],
    verificationState: 'verified',
    daysSinceLastRun: null,
    parents: [],
  } as unknown as AcWithVerification,
];

const ISSUES: Issue[] = [
  {
    id: 'i-1',
    docId: 'doc-uuid',
    seq: 1,
    title: 'A wobble',
    body: '',
    type: 'bug',
    severity: null,
    status: 'resolved',
    source: 'human',
    satisfyingTaskId: null,
    promotedDocId: null,
    createdAt: CREATED_AT,
    updatedAt: COMPLETED_AT,
  } as Issue,
];

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // Any fetch from inside the component is a contract violation (ac-14, and
  // spec-159's original ac-9 no-network posture).
  fetchSpy = vi.fn(() => Promise.reject(new Error('DoneSummary must not fetch')));
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderDone(props: Partial<React.ComponentProps<typeof DoneSummary>> = {}) {
  return render(
    <DoneSummary
      doc={makeDoc()}
      decisions={DECISIONS}
      tasks={TASKS}
      acs={ACS}
      issues={ISSUES}
      {...props}
    />,
  );
}

describe('spec-196 — "Read the spec" on the done view', () => {
  it('renders for a non-member (canReopen false → no Reopen) and is collapsed by default (ac-12, ac-13)', () => {
    tagAc(AC(12));
    tagAc(AC(13));
    renderDone({ canReopen: false });

    // Reading is offered to everyone; Reopen needs write access (canReopen),
    // so a non-member sees the read control but not Reopen.
    expect(screen.queryByTestId('done-reopen')).not.toBeInTheDocument();
    const toggle = screen.getByTestId('done-read-spec');
    expect(toggle).toHaveTextContent('Read the spec');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // Collapsed: the record body is absent.
    expect(screen.queryByTestId('done-read-spec-body')).not.toBeInTheDocument();
  });

  it('Reopen and Read the spec share one footer action row (ac-16)', () => {
    tagAc(AC(16));
    renderDone({ canReopen: true });

    const read = screen.getByTestId('done-read-spec');
    const reopen = screen.getByTestId('done-reopen');
    // Both buttons sit in the SAME row container — not two stacked,
    // separately-divided blocks (the old layout).
    expect(read.parentElement).toBe(reopen.parentElement);
    // Exactly one divider rule fronts the footer (the row's container), not
    // one per button.
    const row = read.parentElement!;
    expect(row.className).toContain('flex');
  });

  it('expanding shows the sorted sections and the full detail; collapsing hides it (ac-12, ac-13)', () => {
    tagAc(AC(12));
    tagAc(AC(13));
    renderDone({ canReopen: true });

    fireEvent.click(screen.getByTestId('done-read-spec'));
    const body = screen.getByTestId('done-read-spec-body');

    // Sections render sorted by seq (s-1 first despite prop order), title
    // falling back to sectionType, markdown rendered as prose.
    const sections = within(body).getAllByTestId('done-read-section');
    expect(sections).toHaveLength(2);
    expect(sections[0].textContent).toContain('1. overview');
    expect(sections[0].textContent).toContain('The first section.');
    expect(sections[0].querySelector('em')?.textContent).toBe('first');
    expect(sections[1].textContent).toContain('2. Design & UX');
    expect(sections[1].querySelector('strong')?.textContent).toBe('second');

    // The detail record — decisions (with resolution), tasks, ACs, issues.
    expect(within(body).getByTestId('done-read-decision').textContent).toContain(
      'We picked the calm one.',
    );
    expect(within(body).getByTestId('done-read-task').textContent).toContain('Ship the thing');
    expect(within(body).getByTestId('done-read-ac').textContent).toContain('The thing ships');
    expect(within(body).getByTestId('done-read-ac').textContent).toContain('verified');
    expect(within(body).getByTestId('done-read-issue').textContent).toContain('A wobble');

    // Toggle closed again — the calm report is the resting state.
    fireEvent.click(screen.getByTestId('done-read-spec'));
    expect(screen.queryByTestId('done-read-spec-body')).not.toBeInTheDocument();
  });

  it('reading is inert: no fetch, no mutation affordances, no phase change (ac-14)', () => {
    tagAc(AC(14));
    const onReopen = vi.fn();
    renderDone({ canReopen: true, onReopen });

    fireEvent.click(screen.getByTestId('done-read-spec'));
    const body = screen.getByTestId('done-read-spec-body');

    // Zero network across render + expand.
    expect(fetchSpy).not.toHaveBeenCalled();
    // Zero mutation affordances inside the record — not a single button.
    expect(within(body).queryAllByRole('button')).toHaveLength(0);
    // Zero phase mutation — expanding/collapsing never touches onReopen.
    fireEvent.click(screen.getByTestId('done-read-spec'));
    expect(onReopen).not.toHaveBeenCalled();
  });
});
