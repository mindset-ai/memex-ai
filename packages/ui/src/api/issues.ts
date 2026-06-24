// spec-354 sol-2: carved out of the former all-domains api/client.ts (which
// is now a barrel re-exporting this module). Behaviour-preserving move only.

import type { Task, Issue, IssueType, MemexIssue } from './types';
import { fetchJson as fetchJsonRaw } from './fetchJson';
import { fetchWithRetry } from './http';
import { tBase } from './internal';

export async function fetchIssues(docId: string): Promise<Issue[]> {
  const res = await fetchWithRetry(`${tBase()}/issues/doc/${docId}`);
  if (!res.ok) throw new Error(`Failed to fetch issues: ${res.status}`);
  return res.json();
}

export async function createIssueApi(
  docId: string,
  title: string,
  body: string,
  type: IssueType,
  severity?: string | null,
): Promise<Issue> {
  const res = await fetchWithRetry(`${tBase()}/issues/doc/${docId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body, type, severity: severity ?? null }),
  });
  if (!res.ok) throw new Error(`Failed to create issue: ${res.status}`);
  return res.json();
}

export async function updateIssueStatusApi(id: string, status: string): Promise<Issue> {
  const res = await fetchWithRetry(`${tBase()}/issues/${id}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) throw new Error(`Failed to update issue: ${res.status}`);
  return res.json();
}

// Down-bridge: Issue → Task (ac-20). Returns the created Task + the spawned
// implementation AC id + the now-`converted` Issue.
export async function convertIssueToTaskApi(
  id: string,
): Promise<{ task: Task; acId: string; issue: Issue }> {
  const res = await fetchWithRetry(`${tBase()}/issues/${id}/convert-to-task`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`Failed to convert issue to task: ${res.status}`);
  return res.json();
}

// Up-bridge: Task → Issue (ac-30). Keyed on the offending agent Task id; the
// server kicks the work up into a human Todo Issue and deletes the Task.
export async function kickTaskToIssueApi(
  taskId: string,
  reason: string,
): Promise<{ issue: Issue; deletedTaskId: string; reverted: boolean }> {
  const res = await fetchWithRetry(`${tBase()}/issues/from-task/${taskId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
  if (!res.ok) throw new Error(`Failed to kick task to issue: ${res.status}`);
  return res.json();
}

// ── Memex-level Issues feed (spec-158 t-4) ──
// The read-only roll-up of every OPEN issue across the Memex, joined to its
// parent Spec — the feed the Issues page groups under each Spec heading. Mirrors
// GET /api/<ns>/<mx>/issues-list (routes/issues-list.ts). Distinct from
// fetchIssues above, which is the per-Spec list; this is the cross-Spec list.

export interface FetchMemexIssuesOptions {
  /** 'mine' (default, server-side) restricts to issues on Specs assigned to the
   *  caller; 'all' widens to the whole Memex. Sent as `?scope=`. */
  scope?: 'mine' | 'all';
  /** Subset of draft/specify/build/verify/done — narrows on the parent Spec's
   *  status. Empty/absent ⇒ all phases. Sent as a CSV `?phases=`. */
  phases?: ReadonlyArray<string>;
  /** Subset of bug/todo — narrows on the issue's type. Empty/absent ⇒ all types.
   *  Sent as a CSV `?types=`. */
  types?: ReadonlyArray<IssueType>;
}

export async function fetchMemexIssues(
  opts?: FetchMemexIssuesOptions,
): Promise<MemexIssue[]> {
  const params = new URLSearchParams();
  if (opts?.scope) params.set('scope', opts.scope);
  if (opts?.phases?.length) params.set('phases', opts.phases.join(','));
  if (opts?.types?.length) params.set('types', opts.types.join(','));
  const qs = params.toString();
  const url = qs ? `${tBase()}/issues-list?${qs}` : `${tBase()}/issues-list`;
  const body = await fetchJsonRaw<{ items: MemexIssue[] }>(fetchWithRetry, url);
  return body.items;
}
