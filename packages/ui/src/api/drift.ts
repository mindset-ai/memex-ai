// spec-354 sol-2: carved out of the former all-domains api/client.ts (which
// is now a barrel re-exporting this module). Behaviour-preserving move only.

import { fetchJson as fetchJsonRaw } from './fetchJson';
import { fetchWithRetry } from './http';
import { tBase } from './internal';

/**
 * One clause operation of a proposal (spec-530 t-7).
 *
 * `after` vs `current` is the diff a reviewer judges. `before` vs `current` says whether
 * the proposal still applies — the row shows both bodies and derives no verdict, because
 * that judgement lives inside the accept transaction (spec-530 dec-3/dec-4), not here.
 */
export interface DriftProposalOperation {
  op: 'edit' | 'delete' | 'add';
  /** The target's `cl-N` handle. For `add`, the ANCHOR it sits relative to. */
  clause: string;
  /** `add` only — which side of the anchor the new clause goes. */
  placement?: 'before' | 'after';
  /** The target's body at authoring time. Absent for `add`. */
  before?: string;
  /** The proposed text. Absent for `delete`. */
  after?: string;
  /** The clause's live body now, or null when it no longer exists. */
  current: string | null;
}

/**
 * A `plan_revision`'s body, as the server read it. `legacy` is a pre-spec-530
 * whole-section replacement (readable, not applyable clause by clause); `unreadable` is
 * a body that parses as neither. Both render an explanatory row rather than breaking the
 * page for every other item on it.
 */
export type DriftProposal =
  | { kind: 'clause-ops'; operations: DriftProposalOperation[] }
  | { kind: 'legacy'; proposed: string }
  | { kind: 'unreadable' };

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
   * Proposed replacement text; non-null for every `plan_revision`, null for a `drift`.
   *
   * spec-530 t-7: **the row does NOT render this.** At the clause grain a proposal is a
   * set of operations with no single "proposed body", so for a clause-ops row this is
   * the raw comment content. It survives because the drift agent's context reads it.
   * Render `proposal` instead.
   */
  proposedContent: string | null;
  /**
   * The proposal's operations, resolved against the live clauses (spec-530 t-7) — what
   * the row renders. `null` for a `drift` observation.
   */
  proposal: DriftProposal | null;
  createdAt: string; // ISO timestamp from the JSON wire
  /**
   * The source DECISION a `drift` finding contradicts (spec-498 dec-4) — its
   * `dec-N` handle + title, so the inbox reads the finding as a relationship
   * ("dec-N contradicts std-M"). `null` for a proposal, or a drift with no
   * linked decision (legacy rows).
   */
  decision: {
    handle: string;
    title: string;
    /**
     * The owning spec's handle (`spec-N`) — lets the row link `dec-N` to its
     * canonical URL `/specs/:specHandle/decisions/:decHandle`. `null` when the
     * decision has no owning spec (edge case) → rendered as a non-linked handle.
     */
    specHandle: string | null;
  } | null;
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
