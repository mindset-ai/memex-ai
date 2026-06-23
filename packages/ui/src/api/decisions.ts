// spec-354 sol-2: carved out of the former all-domains api/client.ts (which
// is now a barrel re-exporting this module). Behaviour-preserving move only.

import type { Decision, Task } from './types';
import { NotFoundError } from './errors';
import { fetchJson as fetchJsonRaw } from './fetchJson';
import { fetchWithRetry } from './http';
import { tBase } from './internal';

/**
 * Look up a decision by its `dec-N` handle, scoped to the current account
 * (server resolves the account from the session). Used by t-18's
 * `<DecisionLink>` component to follow standard `[per dec-N]` references
 * to the source decision's parent spec doc.
 */
export async function fetchTaskByHandle(
  handle: string,
  parentDocId?: string,
): Promise<Task> {
  // b-42 t-2: `?docId=` scopes lookup so a memex with multiple Specs each
  // having a t-1 doesn't 409 on link clicks. Caller passes the doc id of the
  // context the link was rendered in (section / comment owner doc).
  const query = parentDocId ? `?docId=${encodeURIComponent(parentDocId)}` : "";
  return fetchJsonRaw<Task>(
    fetchWithRetry,
    `${tBase()}/tasks/by-handle/${encodeURIComponent(handle)}${query}`,
    undefined,
    {
      errorFactory: (status) => {
        if (status === 404) return new NotFoundError(`Task ${handle} not found`);
        return new Error(`Failed to fetch task ${handle}: ${status}`);
      },
    },
  );
}

/**
 * Resolve a decision handle to a Decision row.
 *
 * Accepts three forms:
 *   - bare              `dec-N`        (legacy, t-18)
 *   - doc-qualified     `doc-N:dec-M`  (legacy qualified, t-20 W-A)
 *   - Spec-qualified    `mis-N:dec-M`  (canonical, t-7 — server-side asserts
 *                                       parent is a Spec; `mis-` literal
 *                                       pre-dates the b-105 rename)
 * The colon is URL-encoded so `mis-3:dec-7` goes over the wire as
 * `mis-3%3Adec-7`.
 *
 * Errors:
 *   - 404 → `NotFoundError` (handle resolves to no decision in the account)
 *   - 409 → plain `Error` carrying the server's "ambiguous" message AND the
 *           candidate qualified handles in `.message` (so the UI can surface
 *           "ambiguous reference" without parsing JSON; future work can move
 *           the candidates into a structured field). The same path covers
 *           `mis-N:dec-M` cites whose parent isn't a Spec (t-7).
 */
export async function fetchDecisionByHandle(
  handle: string,
  parentDocId?: string,
): Promise<Decision> {
  // b-42 t-2: `?docId=` scopes lookup so a memex with multiple Specs each
  // having a dec-1 doesn't 409 on link clicks. Qualified handles (`doc-N:dec-M`,
  // `mis-N:dec-M`) ignore the query — they already encode the parent.
  const query = parentDocId ? `?docId=${encodeURIComponent(parentDocId)}` : "";
  const url = `${tBase()}/decisions/by-handle/${encodeURIComponent(handle)}${query}`;
  const res = await fetchWithRetry(url);
  if (res.ok) {
    return res.json();
  }
  if (res.status === 404) {
    throw new NotFoundError(`Decision ${handle} not found`);
  }
  if (res.status === 409) {
    // Server returns { error, code: 'AMBIGUOUS_DECISION_HANDLE', candidates: [...] }
    let body: { error?: string; candidates?: string[] } = {};
    try {
      body = await res.json();
    } catch {
      /* ignore */
    }
    const detail =
      body.candidates && body.candidates.length > 0
        ? ` Candidates: ${body.candidates.join(', ')}`
        : '';
    throw new Error(
      `${body.error ?? `Decision ${handle} is ambiguous`}${detail}`,
    );
  }
  throw new Error(`Failed to fetch decision: ${res.status}`);
}

export async function fetchDecisions(docId: string): Promise<Decision[]> {
  const res = await fetchWithRetry(`${tBase()}/decisions/doc/${docId}`);
  if (!res.ok) throw new Error(`Failed to fetch decisions: ${res.status}`);
  return res.json();
}

export async function createDecision(docId: string, title: string): Promise<Decision> {
  const res = await fetchWithRetry(`${tBase()}/decisions/doc/${docId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(`Failed to create decision: ${res.status}`);
  return res.json();
}

/**
 * Resolve a decision. When the decision carries `options[]`, pass
 * `chosenOptionIndex` to record which option was selected — the server
 * persists it on the row (per t-5 / dec-8). `resolution` is optional when an
 * index is supplied (spec-247 dec-5: persist-on-select — the server defaults
 * the prose to the chosen option's label). Re-resolving an already-resolved
 * decision updates the choice in place.
 */
export async function resolveDecisionApi(
  id: string,
  resolution?: string,
  chosenOptionIndex?: number,
): Promise<Decision> {
  const body: { resolution?: string; chosenOptionIndex?: number } = {};
  if (resolution !== undefined) body.resolution = resolution;
  if (chosenOptionIndex !== undefined) body.chosenOptionIndex = chosenOptionIndex;
  const res = await fetchWithRetry(`${tBase()}/decisions/${id}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Failed to resolve decision: ${res.status}`);
  return res.json();
}

export async function reopenDecisionApi(id: string): Promise<Decision> {
  const res = await fetchWithRetry(`${tBase()}/decisions/${id}/reopen`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`Failed to reopen decision: ${res.status}`);
  return res.json();
}

/**
 * Approve a candidate decision (candidate → open). Throws if the decision is
 * not currently a candidate (server-side strict transition per t-5).
 */
export async function approveDecisionApi(id: string): Promise<Decision> {
  const res = await fetchWithRetry(`${tBase()}/decisions/${id}/approve`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`Failed to approve decision: ${res.status}`);
  return res.json();
}

/**
 * Reject a candidate decision (candidate → rejected). The reason is persisted
 * in `resolution`. Throws if the decision is not currently a candidate.
 */
export async function rejectDecisionApi(id: string, reason: string): Promise<Decision> {
  const res = await fetchWithRetry(`${tBase()}/decisions/${id}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
  if (!res.ok) throw new Error(`Failed to reject decision: ${res.status}`);
  return res.json();
}
