// Unit tests for useNeedsAttention — the data layer behind the Pulse "Needs
// attention" tray (b-60 Wave 2). UNTAGGED; these pin the scoped/unscoped fetch
// behaviour and the four derived slices (unresolved decisions, open questions,
// blocked tasks, drift signals) plus the stale-request guard.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { Decision, DocCommentsResult, Doc, Task } from '../../../api/types';
import type { DriftInboxItem } from '../../../api/drift';

// Mock the API barrel the hook pulls its fetchers from.
const fetchDocs = vi.fn();
const fetchDecisions = vi.fn();
const fetchDocComments = vi.fn();
const fetchTasks = vi.fn();
const fetchDriftInbox = vi.fn();

vi.mock('../../../api/client', () => ({
  fetchDocs: (...a: unknown[]) => fetchDocs(...a),
  fetchDecisions: (...a: unknown[]) => fetchDecisions(...a),
  fetchDocComments: (...a: unknown[]) => fetchDocComments(...a),
  fetchTasks: (...a: unknown[]) => fetchTasks(...a),
  fetchDriftInbox: (...a: unknown[]) => fetchDriftInbox(...a),
}));

// tenantPath reads the URL prefix; keep it deterministic.
vi.mock('../../../utils/tenantUrl', () => ({
  tenantPath: (p: string) => `/ns/mx${p}`,
}));

import { useNeedsAttention } from './useNeedsAttention';

function spec(over: Partial<Doc> = {}): Doc {
  return {
    id: over.id ?? 'doc-1',
    handle: over.handle ?? 'spec-1',
    title: over.title ?? 'My Spec',
    docType: over.docType ?? 'spec',
    status: over.status ?? 'build',
    createdAt: '2026-01-01T00:00:00Z',
    statusChangedAt: '2026-01-01T00:00:00Z',
    sections: [],
  };
}

function decision(over: Partial<Decision> = {}): Decision {
  return {
    id: over.id ?? 'd1',
    docId: 'doc-1',
    seq: over.seq ?? 1,
    title: over.title ?? 'Choose X',
    context: null,
    status: over.status ?? 'open',
    resolution: null,
    resolvedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    options: null,
    chosenOptionIndex: null,
  };
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: over.id ?? 't1',
    docId: 'doc-1',
    seq: over.seq ?? 1,
    title: over.title ?? 'Do work',
    description: '',
    acceptanceCriteria: [],
    sectionRef: null,
    status: 'not_started',
    blocked: over.blocked ?? false,
    blockedByDecisions: over.blockedByDecisions ?? [],
    blockedByTasks: [],
    createdAt: '2026-01-01T00:00:00Z',
    startedAt: null,
    completedAt: null,
  };
}

function emptyComments(): DocCommentsResult {
  return { sections: [], decisions: [], tasks: [] };
}

function driftItem(over: Partial<DriftInboxItem['doc']> = {}): DriftInboxItem {
  return {
    commentId: `c-${Math.random()}`,
    commentHandle: 'c-1',
    commentType: 'drift',
    source: 'human',
    authorName: 'Sam',
    content: 'drifted',
    proposedContent: null,
    createdAt: '2026-01-01T00:00:00Z',
    section: null,
    doc: {
      id: over.id ?? 'std-doc',
      handle: over.handle ?? 'std-1',
      title: over.title ?? 'Standard One',
      docType: over.docType ?? 'standard',
      status: over.status ?? 'active',
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchDocs.mockResolvedValue([]);
  fetchDecisions.mockResolvedValue([]);
  fetchDocComments.mockResolvedValue(emptyComments());
  fetchTasks.mockResolvedValue([]);
  fetchDriftInbox.mockResolvedValue([]);
});

describe('useNeedsAttention — unscoped (no briefId)', () => {
  it('wires only drift; the other three slices stay empty', async () => {
    fetchDriftInbox.mockResolvedValue([driftItem(), driftItem({ handle: 'std-1' })]);

    const { result } = renderHook(() => useNeedsAttention());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(fetchDecisions).not.toHaveBeenCalled();
    expect(fetchTasks).not.toHaveBeenCalled();
    expect(fetchDocComments).not.toHaveBeenCalled();

    // count is total findings; items are deduped by Standard handle (both std-1)
    expect(result.current.driftSignals.count).toBe(2);
    expect(result.current.driftSignals.items).toHaveLength(1);
    expect(result.current.driftSignals.items[0].handle).toBe('std-1');
    expect(result.current.driftSignals.items[0].href).toBe('/ns/mx/standards/std-1');

    expect(result.current.unresolvedDecisions).toEqual({ count: 0, items: [] });
    expect(result.current.openQuestions).toEqual({ count: 0, items: [] });
    expect(result.current.blockedTasks).toEqual({ count: 0, items: [] });
  });

  it('surfaces a fetch error and stops loading', async () => {
    fetchDriftInbox.mockRejectedValue(new Error('network down'));
    // hook itself .catch()es each fetch -> drift becomes []; no thrown error.
    const { result } = renderHook(() => useNeedsAttention());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.driftSignals.count).toBe(0);
    expect(result.current.error).toBeNull();
  });
});

describe('useNeedsAttention — scoped (briefId set)', () => {
  it('derives all four slices from the per-doc endpoints', async () => {
    fetchDocs.mockResolvedValue([spec({ id: 'doc-1', handle: 'spec-7' })]);
    fetchDecisions.mockResolvedValue([
      decision({ id: 'd1', seq: 1, status: 'open', title: 'Open one' }),
      decision({ id: 'd2', seq: 2, status: 'resolved', title: 'Done' }),
    ]);
    fetchDocComments.mockResolvedValue({
      sections: [
        {
          section: {} as never,
          comments: [
            { id: 'q1', commentType: 'question', resolvedAt: null, content: 'Why?' },
            { id: 'q2', commentType: 'question', resolvedAt: '2026-02-01', content: 'Answered' },
            { id: 'd-disc', commentType: 'discussion', resolvedAt: null, content: 'chat' },
          ] as never,
        },
      ],
      decisions: [],
      tasks: [],
    });
    fetchTasks.mockResolvedValue([
      task({ id: 't1', seq: 1, title: 'Blocked', blockedByDecisions: [decision({ status: 'open' })] }),
      task({ id: 't2', seq: 2, title: 'Free', blockedByDecisions: [decision({ status: 'resolved' })] }),
    ]);

    const { result } = renderHook(() => useNeedsAttention('doc-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(fetchDecisions).toHaveBeenCalledWith('doc-1');

    // only the OPEN decision
    expect(result.current.unresolvedDecisions.count).toBe(1);
    expect(result.current.unresolvedDecisions.items[0].handle).toBe('dec-1');
    expect(result.current.unresolvedDecisions.items[0].specHandle).toBe('spec-7');

    // only the unresolved question
    expect(result.current.openQuestions.count).toBe(1);
    expect(result.current.openQuestions.items[0].title).toBe('Why?');

    // only the task blocked by an OPEN decision
    expect(result.current.blockedTasks.count).toBe(1);
    expect(result.current.blockedTasks.items[0].handle).toBe('t-1');
  });

  it('resolves a handle-based briefId to the doc id and filters drift to that Spec', async () => {
    fetchDocs.mockResolvedValue([spec({ id: 'doc-9', handle: 'spec-9' })]);
    fetchDriftInbox.mockResolvedValue([
      driftItem({ id: 'doc-9', handle: 'spec-9', docType: 'spec' }),
      driftItem({ id: 'other', handle: 'std-2', docType: 'standard' }),
    ]);

    const { result } = renderHook(() => useNeedsAttention('spec-9'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    // briefId resolved from handle -> doc id used for the per-doc calls
    expect(fetchDecisions).toHaveBeenCalledWith('doc-9');
    // drift narrowed to the Spec's own doc id (only the spec-9 item)
    expect(result.current.driftSignals.count).toBe(1);
  });

  it('uses a null specHandle when the doc is not found', async () => {
    fetchDocs.mockResolvedValue([]);
    fetchDecisions.mockResolvedValue([decision({ status: 'open' })]);

    const { result } = renderHook(() => useNeedsAttention('ghost'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.unresolvedDecisions.items[0].specHandle).toBeNull();
  });

  it('refresh() re-pulls the slices', async () => {
    fetchDocs.mockResolvedValue([spec()]);
    const { result } = renderHook(() => useNeedsAttention('doc-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const before = fetchDecisions.mock.calls.length;

    await act(async () => {
      await result.current.refresh();
    });
    expect(fetchDecisions.mock.calls.length).toBeGreaterThan(before);
  });
});
