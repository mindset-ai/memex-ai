// spec-354 sol-2: carved out of the former all-domains api/client.ts (which
// is now a barrel re-exporting this module). Behaviour-preserving move only.

import { fetchJson as fetchJsonRaw } from './fetchJson';
import { fetchWithRetry } from './http';
import { tBase } from './internal';

/**
 * Drift Inbox row — open `drift` or `plan_revision` typed comment with parent
 * doc + section context attached. See packages/server/src/services/drift-inbox.ts
 * for the canonical shape.
 */
export interface DriftInboxItem {
  commentId: string;
  /** The comment's per-doc `c-N` handle (spec-143 i-2) — rendered on the row
   *  and threaded into the drift_item focus chip so the agent gets an
   *  actionable ref without a list_comments round-trip. */
  commentHandle: string;
  commentType: 'drift' | 'plan_revision';
  source: 'human' | 'agent' | null;
  authorName: string;
  content: string;
  /**
   * Normalized proposed replacement text (spec-143 dec-2 / ac-9). The server
   * guarantees this is non-null for every `plan_revision` — including proposals
   * authored without the `~~~proposed-content` fence — so the inbox always
   * renders a proposal as a before/after diff and never falls through to an
   * undifferentiated blob. `null` for a `drift` observation.
   */
  proposedContent: string | null;
  createdAt: string; // ISO timestamp from the JSON wire
  section: {
    id: string;
    sectionType: string;
    title: string | null;
    content: string;
  } | null;
  doc: {
    id: string;
    handle: string;
    title: string;
    docType: string;
    status: string;
  };
}

/**
 * Fetch the Standards Drift Inbox. Pass `{ doc: 'std-N' }` to narrow to a
 * single standard (the per-standard drift-badge deep-link → `/drift?doc=std-N`).
 */
export async function fetchDriftInbox(
  opts?: { doc?: string },
): Promise<DriftInboxItem[]> {
  const qs = opts?.doc ? `?doc=${encodeURIComponent(opts.doc)}` : '';
  const body = await fetchJsonRaw<{ items: DriftInboxItem[] }>(
    fetchWithRetry,
    `${tBase()}/drift${qs}`,
  );
  return body.items;
}
