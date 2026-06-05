// Tests for DoneSummary (spec-159 t-4) — the report view shown when a Spec is
// done. Two load-bearing properties are pinned:
//
//   • ac-8: a SINGLE-column report renders from the passed-in Spec data —
//     completion line (date + relative), timeline, and decision/task/AC/issue
//     counts — with NO two-column layout and NO sub-tab bar.
//   • ac-9: the view is rendered entirely from already-fetched props — it makes
//     NO network call of its own (no new endpoint / stored artifact).
//
// The component takes plain props (the same shapes the other panels receive),
// so no ChatProvider / router wrapping is needed and nothing is mocked except a
// global fetch spy that asserts the no-network contract.

import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { DoneSummary } from './DoneSummary';
import type { Decision, Task, Issue, DocWithGraph } from '../api/types';
import type { AcWithVerification, DocAssigneeView } from '../api/client';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-159/acs/ac-${n}`;

// ── Fixtures ─────────────────────────────────────────────────────────────
// A done Spec created 7 days before completion, completed 3 days ago.
const NOW = Date.parse('2026-06-12T12:00:00Z');
const CREATED_AT = '2026-06-02T12:00:00Z'; // 7 days before completion
const COMPLETED_AT = '2026-06-09T12:00:00Z'; // 3 days before NOW

function makeDoc(overrides: Partial<DocWithGraph> = {}): DocWithGraph {
  return {
    id: 'doc-uuid',
    handle: 'spec-159',
    title: 'Spec page restructure',
    docType: 'spec',
    status: 'done',
    creator: { name: 'Barrie Hadfield', email: 'barrie@mindset.ai' },
    createdAt: CREATED_AT,
    statusChangedAt: COMPLETED_AT,
    sections: [],
    decisions: [],
    tasks: [],
    ...overrides,
  };
}

function decision(seq: number, status: Decision['status']): Decision {
  return {
    id: `dec-${seq}`,
    docId: 'doc-uuid',
    seq,
    title: `Decision ${seq}`,
    context: null,
    status,
    resolution: status === 'resolved' ? 'resolved text' : null,
    resolvedAt: status === 'resolved' ? COMPLETED_AT : null,
    createdAt: CREATED_AT,
    options: null,
    chosenOptionIndex: null,
  };
}

function task(seq: number, status: Task['status']): Task {
  return {
    id: `t-${seq}`,
    docId: 'doc-uuid',
    seq,
    title: `Task ${seq}`,
    description: '',
    acceptanceCriteria: [],
    sectionRef: null,
    status,
    blocked: false,
    blockedByDecisions: [],
    blockedByTasks: [],
    createdAt: CREATED_AT,
    startedAt: null,
    completedAt: status === 'complete' ? COMPLETED_AT : null,
  };
}

function ac(seq: number, state: AcWithVerification['verificationState']): AcWithVerification {
  return {
    ac: {
      id: `ac-${seq}`,
      memexId: 'memex',
      briefId: 'doc-uuid',
      seq,
      kind: 'implementation',
      statement: `AC ${seq}`,
      status: 'active',
      createdAt: CREATED_AT,
      updatedAt: COMPLETED_AT,
    },
    canonicalRef: AC(seq),
    tests: [],
    verificationState: state,
    daysSinceLastRun: null,
    parents: [],
  };
}

function issue(seq: number, status: Issue['status']): Issue {
  return {
    id: `i-${seq}`,
    docId: 'doc-uuid',
    seq,
    title: `Issue ${seq}`,
    body: '',
    type: 'bug',
    severity: null,
    status,
    source: 'human',
    satisfyingTaskId: null,
    promotedDocId: null,
    createdAt: CREATED_AT,
    updatedAt: COMPLETED_AT,
  };
}

// 5 decisions resolved · 7 tasks complete + 1 not (kicked) · 12 ACs / 12 verified
// · 3 issues raised / 3 resolved — mirrors sketch F's example numbers.
const DECISIONS: Decision[] = Array.from({ length: 5 }, (_, i) => decision(i + 1, 'resolved'));
const TASKS: Task[] = [
  ...Array.from({ length: 7 }, (_, i) => task(i + 1, 'complete')),
  task(8, 'in_progress'),
];
const ACS: AcWithVerification[] = Array.from({ length: 12 }, (_, i) => ac(i + 1, 'verified'));
const ISSUES: Issue[] = Array.from({ length: 3 }, (_, i) => issue(i + 1, 'resolved'));

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  // Any fetch from inside the component is a contract violation (ac-9).
  fetchSpy = vi.fn(() => Promise.reject(new Error('DoneSummary must not fetch')));
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('DoneSummary', () => {
  it('renders a single-column report with completion line and counts from props', () => {
    tagAc(AC(8));
    render(
      <DoneSummary doc={makeDoc()} decisions={DECISIONS} tasks={TASKS} acs={ACS} issues={ISSUES} />,
    );

    const report = screen.getByTestId('done-summary');

    // Completion headline — date + relative time ("3 days ago").
    expect(report.textContent).toMatch(/completed on .*2026/);
    expect(report.textContent).toContain('3 days ago');

    // Timeline with total duration (7 days created → done).
    const timeline = within(report).getByText('Timeline').parentElement!;
    expect(timeline.textContent).toContain('7 days total');

    // Count rows — derived purely from the fixture props.
    const decisions = within(report).getByText('Decisions').parentElement!;
    expect(decisions.textContent).toContain('5 resolved');

    const tasks = within(report).getByText('Tasks').parentElement!;
    expect(tasks.textContent).toContain('7 completed');
    expect(tasks.textContent).toContain('1 kicked to issue');

    const acceptance = within(report).getByText('Acceptance').parentElement!;
    expect(acceptance.textContent).toContain('12 ACs');
    expect(acceptance.textContent).toContain('12 verified');

    const issues = within(report).getByText('Issues').parentElement!;
    expect(issues.textContent).toContain('3 raised');
    expect(issues.textContent).toContain('3 resolved');

    // People — falls back to the doc creator when no assignees are passed.
    const people = within(report).getByText('People').parentElement!;
    expect(people.textContent).toContain('Barrie Hadfield');
  });

  it('shows assignees in the People row when passed (still no fetch)', () => {
    tagAc(AC(8));
    const people: DocAssigneeView[] = [
      { userId: 'u1', name: 'Ryan M', email: 'ryan@x.com', assignedAt: COMPLETED_AT },
    ];
    render(
      <DoneSummary
        doc={makeDoc()}
        decisions={DECISIONS}
        tasks={TASKS}
        acs={ACS}
        issues={ISSUES}
        people={people}
      />,
    );

    const peopleRow = within(screen.getByTestId('done-summary')).getByText('People').parentElement!;
    expect(peopleRow.textContent).toContain('Ryan M');
  });

  it('renders no sub-tab bar and no two-column layout markers', () => {
    tagAc(AC(8));
    const { container } = render(
      <DoneSummary doc={makeDoc()} decisions={DECISIONS} tasks={TASKS} acs={ACS} issues={ISSUES} />,
    );

    // No tablist/tab roles — the report is not a tabbed surface.
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);

    // No two-column grid: no element declares a 2-column track. (The page's
    // Build/Verify layouts use grid-cols-2; the Summary must not.)
    expect(container.querySelector('.grid-cols-2')).toBeNull();
    expect(container.querySelector('[class*="md:grid-cols-2"]')).toBeNull();
  });

  it('does not fetch — renders entirely from already-fetched props (no new endpoint/artifact)', () => {
    tagAc(AC(9));
    render(
      <DoneSummary doc={makeDoc()} decisions={DECISIONS} tasks={TASKS} acs={ACS} issues={ISSUES} />,
    );

    // The whole report came from props — the component issued zero requests.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('degrades gracefully with empty data — renders without throwing (no fetch)', () => {
    tagAc(AC(9));
    render(<DoneSummary doc={makeDoc()} decisions={[]} tasks={[]} acs={[]} issues={[]} />);

    const report = screen.getByTestId('done-summary');
    expect(within(report).getByText('Decisions').parentElement!.textContent).toContain('0 resolved');
    expect(within(report).getByText('Acceptance').parentElement!.textContent).toContain('0 ACs');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
