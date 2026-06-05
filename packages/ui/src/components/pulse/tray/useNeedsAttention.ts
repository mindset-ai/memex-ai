import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchDocs,
  fetchDecisions,
  fetchDocComments,
  fetchTasks,
  fetchDriftInbox,
} from '../../../api/client';
import type { Decision, Task } from '../../../api/types';

/**
 * useNeedsAttention — the data layer behind the Pulse (b-60) "Needs attention"
 * tray (Wave 2). Fetches the four tile datasets — unresolved decisions, open
 * questions, drift signals, blocked tasks — for the current Memex, optionally
 * narrowed to ONE Spec (per dec-9).
 *
 * Tenancy + auth follow the existing admin conventions: every helper used here
 * (fetchDocs / fetchDecisions / fetchDocComments / fetchTasks / fetchDriftInbox)
 * resolves the tenant prefix from the URL path via `tBase()` in api/client.ts
 * and auto-attaches the bearer token through `fetchWithRetry`. So this hook
 * passes NO namespace/memex — same as every other tenant-scoped call.
 *
 * Endpoint coverage (b-60 Wave 2):
 *   - Drift signals — WIRED to GET …/drift (fetchDriftInbox). Memex-wide, ready.
 *   - Decisions / Questions / Blocked tasks — the server exposes only PER-DOC
 *     list endpoints today (fetchDecisions(docId) / fetchDocComments(docId) /
 *     fetchTasks(docId)); there is no memex-wide aggregate. So:
 *       • briefId SET   → fully WIRED via the per-doc endpoints (one round-trip
 *                         each, scoped to that Spec).
 *       • briefId UNSET → the aggregate would require a fan-out over every Spec
 *                         (or a new server endpoint, out of scope for this task).
 *                         These tiles return {count:0, items:[]} so they render
 *                         gracefully. See the // TODO markers below.
 */

/**
 * One recent item rendered inside a tile as a deep-link. Generic across the four
 * tiles — `handle` is the entity handle (dec-N / t-N / a Standard handle), and
 * `specHandle` is the owning Spec's handle (spec-N / legacy b-N) when known,
 * for the "(spec handle, dec handle, title-stub)" display the tiles want.
 */
export interface NeedsAttentionItem {
  /** Stable key — entity UUID where available, else a synthesised id. */
  id: string;
  /** Entity handle for display (e.g. `dec-7`, `t-3`, or a Standard handle). */
  handle: string;
  /** Owning Spec handle (e.g. `spec-12` / legacy `b-12`), or null for memex-level / non-spec. */
  specHandle: string | null;
  /** Owning Spec id — lets a tile build a `/specs/:id` deep-link. */
  briefId: string | null;
  /** Short title / label for the item (the title-stub). */
  title: string;
  /** Per-item deep-link target (relative path). When absent the tile falls back
   *  to its own "view all" target. */
  href?: string;
}

/** One tile's data slice — a total count plus the most-recent few items. */
export interface AttentionSlice {
  count: number;
  items: NeedsAttentionItem[];
}

const EMPTY_SLICE: AttentionSlice = { count: 0, items: [] };

export interface NeedsAttentionData {
  unresolvedDecisions: AttentionSlice;
  openQuestions: AttentionSlice;
  driftSignals: AttentionSlice;
  blockedTasks: AttentionSlice;
}

export interface UseNeedsAttentionResult extends NeedsAttentionData {
  /** True while the initial fetch (or a briefId-triggered refetch) is in flight. */
  loading: boolean;
  /** Last fetch error message, or null. */
  error: string | null;
  /** Re-pull all four slices (e.g. on an SSE change event from the page). */
  refresh: () => Promise<void>;
}

const EMPTY_DATA: NeedsAttentionData = {
  unresolvedDecisions: EMPTY_SLICE,
  openQuestions: EMPTY_SLICE,
  driftSignals: EMPTY_SLICE,
  blockedTasks: EMPTY_SLICE,
};

// How many recent items each tile shows. The tiles take the first 2-3.
const RECENT_LIMIT = 3;

function decHandle(d: Pick<Decision, 'seq'>): string {
  return `dec-${d.seq}`;
}

function taskHandle(t: Pick<Task, 'seq'>): string {
  return `t-${t.seq}`;
}

/**
 * Spec-scoped fetch: when the tray is narrowed to one Spec we have ready
 * per-doc endpoints for decisions / questions / blocked tasks, so we wire all
 * four slices. `specHandle` is resolved once up front from fetchDocs.
 */
async function fetchScoped(briefId: string): Promise<NeedsAttentionData> {
  // Resolve the Spec's handle for the item tuples. A single docs list call
  // (cheap, already cached app-wide in practice) maps id → handle.
  const docs = await fetchDocs().catch(() => []);
  const spec = docs.find((d) => d.id === briefId || d.handle === briefId);
  const specHandle = spec?.handle ?? null;
  const resolvedBriefId = spec?.id ?? briefId;

  const [decisions, comments, tasks, drift] = await Promise.all([
    fetchDecisions(resolvedBriefId).catch(() => [] as Decision[]),
    fetchDocComments(resolvedBriefId, ['question']).catch(() => null),
    fetchTasks(resolvedBriefId).catch(() => [] as Task[]),
    // Drift is memex-wide; narrow to this Spec client-side below.
    fetchDriftInbox().catch(() => []),
  ]);

  // Unresolved decisions: status === 'open' (candidate/resolved/rejected excluded).
  const openDecisions = decisions.filter((d) => d.status === 'open');
  const unresolvedDecisions: AttentionSlice = {
    count: openDecisions.length,
    items: openDecisions.slice(0, RECENT_LIMIT).map((d) => ({
      id: d.id,
      handle: decHandle(d),
      specHandle,
      briefId: resolvedBriefId,
      title: d.title,
      href: `/specs/${resolvedBriefId}?decision=${encodeURIComponent(decHandle(d))}`,
    })),
  };

  // Open questions: comment_type === 'question' AND unresolved (resolvedAt null).
  // fetchDocComments groups by owner; flatten across sections/decisions/tasks.
  const questionComments = comments
    ? [
        ...comments.sections.flatMap((s) => s.comments),
        ...comments.decisions.flatMap((d) => d.comments),
        ...comments.tasks.flatMap((t) => t.comments),
      ].filter((c) => c.commentType === 'question' && c.resolvedAt == null)
    : [];
  const openQuestions: AttentionSlice = {
    count: questionComments.length,
    items: questionComments.slice(0, RECENT_LIMIT).map((c) => ({
      id: c.id,
      handle: 'question',
      specHandle,
      briefId: resolvedBriefId,
      title: c.content,
      href: `/specs/${resolvedBriefId}`,
    })),
  };

  // Blocked tasks: blocked by at least one OPEN decision (per the tile spec —
  // "tasks blocked by open decisions"). Task.blockedByDecisions carries the
  // blocking decision rows; keep tasks with any open blocker.
  const blocked = tasks.filter((t) =>
    t.blockedByDecisions.some((d) => d.status === 'open'),
  );
  const blockedTasks: AttentionSlice = {
    count: blocked.length,
    items: blocked.slice(0, RECENT_LIMIT).map((t) => ({
      id: t.id,
      handle: taskHandle(t),
      specHandle,
      briefId: resolvedBriefId,
      title: t.title,
      href: `/specs/${resolvedBriefId}?tab=tasks&task=${encodeURIComponent(taskHandle(t))}`,
    })),
  };

  // Drift signals scoped to this Spec: drift comments whose owning doc IS this
  // Spec. (Drift usually targets Standards memex-wide, so this is often empty
  // for a Spec scope — that's correct.)
  const scopedDrift = drift.filter((item) => item.doc.id === resolvedBriefId);
  const driftSignals = driftSliceFrom(scopedDrift);

  return { unresolvedDecisions, openQuestions, driftSignals, blockedTasks };
}

/**
 * Memex-wide fetch. Only drift has a ready aggregate endpoint; the other three
 * have no memex-wide list (per-doc only) so they return EMPTY until either a
 * server aggregate lands or the page passes a briefId.
 */
async function fetchUnscoped(): Promise<NeedsAttentionData> {
  const drift = await fetchDriftInbox().catch(() => []);

  // TODO wire to a memex-wide GET …/decisions?status=open (no aggregate endpoint
  // today — only fetchDecisions(docId)). Until then the unscoped tile is empty.
  const unresolvedDecisions: AttentionSlice = EMPTY_SLICE;

  // TODO wire to a memex-wide GET …/comments?type=question&resolved=false (no
  // aggregate endpoint today — only fetchDocComments(docId)).
  const openQuestions: AttentionSlice = EMPTY_SLICE;

  // TODO wire to a memex-wide GET …/tasks?blocked=true (no aggregate endpoint
  // today — only fetchTasks(docId)).
  const blockedTasks: AttentionSlice = EMPTY_SLICE;

  const driftSignals = driftSliceFrom(drift);

  return { unresolvedDecisions, openQuestions, driftSignals, blockedTasks };
}

/**
 * Build the drift slice from drift-inbox items. The count is the TOTAL number
 * of open drift items; `items` surfaces the affected Standards (deduped by
 * Standard handle) since the tile shows "affected Standards handles".
 */
function driftSliceFrom(
  drift: Awaited<ReturnType<typeof fetchDriftInbox>>,
): AttentionSlice {
  // Affected Standards: drift items whose owning doc is a Standard. Dedupe on
  // the Standard handle so a Standard with two drift findings shows once.
  const byHandle = new Map<string, NeedsAttentionItem>();
  for (const item of drift) {
    if (item.doc.docType !== 'standard') continue;
    if (byHandle.has(item.doc.handle)) continue;
    byHandle.set(item.doc.handle, {
      id: item.doc.id,
      handle: item.doc.handle,
      specHandle: null,
      briefId: null,
      title: item.doc.title,
      href: `/standards/${item.doc.handle}`,
    });
  }
  return {
    // Count is total open drift findings (the work to triage), not the deduped
    // Standard count — a Standard with 3 findings is 3 things to look at.
    count: drift.length,
    items: Array.from(byHandle.values()).slice(0, RECENT_LIMIT),
  };
}

export function useNeedsAttention(briefId?: string): UseNeedsAttentionResult {
  const [data, setData] = useState<NeedsAttentionData>(EMPTY_DATA);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Guard against overlapping/stale fetches writing late results.
  const reqToken = useRef(0);

  const refresh = useCallback(async () => {
    const myReq = ++reqToken.current;
    setLoading(true);
    setError(null);
    try {
      const next = briefId ? await fetchScoped(briefId) : await fetchUnscoped();
      if (myReq !== reqToken.current) return; // superseded
      setData(next);
    } catch (err) {
      if (myReq !== reqToken.current) return;
      setError(
        err instanceof Error ? err.message : 'Failed to load attention items',
      );
    } finally {
      if (myReq === reqToken.current) setLoading(false);
    }
  }, [briefId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { ...data, loading, error, refresh };
}
