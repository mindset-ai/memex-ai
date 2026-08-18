import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { fetchDriftInbox, type DriftInboxItem } from '../api/client';
import { useDocChangeStream } from '../hooks/useDocChangeStream';
import { useChat } from '../components/ChatContext';
import { tenantPath } from '../utils/tenantUrl';
import { timeAgo } from '../utils/timeAgo';
import { Spinner } from '../components/Spinner';
import { OpeningDriftController } from '../components/chat/OpeningDriftController';
import { ProposalDisclosure } from '../components/drift/ProposalDisclosure';

/**
 * Standards Drift Inbox (t-10 of doc-8; scoped to Standards in b-63). Surfaces
 * every open `drift` and `plan_revision` typed comment on a Standard with
 * parent doc context, so standard owners see everything that needs review in
 * one place. Drift is a standards-only concept, so every row links to a
 * Standard. An optional `?doc=std-N` query param (the per-standard drift-badge
 * deep-link) narrows the inbox to a single standard.
 *
 * Two explicit row types (spec-143 dec-2), reworked (spec-498) to echo the Brain
 * "drift card" — the important information at a glance, not a wall of text:
 *   - Observation (`drift`) — the repo has diverged from a rule. Rendered as a
 *     RELATIONSHIP: the source decision (`dec-N` + title) ✗ contradicts the
 *     standard (`std-N` + title) it violates. The full comment body is NOT dumped
 *     into the list (too much to read); the agent explains detail on Discuss.
 *   - Proposal (`plan_revision`) — a proposed change to a standard. Rendered as a
 *     one-line "Proposes a change to std-N …" plus a COLLAPSED disclosure carrying the
 *     per-clause before/after (spec-530 t-7). Collapsed means not rendered, not hidden:
 *     the list stays scannable at a glance, which is what spec-498 was protecting, and
 *     a 12-operation proposal is still one line until the reader opens it.
 *
 * This header used to claim the diff was "reachable via Discuss with Agent or the
 * standard page". Verified 2026-08-13: it was reachable via NEITHER — `proposedContent`
 * came down the wire and was rendered by no component, so a user judging a proposal had
 * no way to see what it said. That claim is corrected rather than deleted, because the
 * gap between what a comment promises and what the code does is the defect spec-530 is
 * named after.
 *
 * No inline action buttons (spec-143 dec-3). The per-row Accept / Reject /
 * Resolve buttons are gone — deciding whether a standard should change in
 * response to drift is a judgement, not a one-click yes/no. Instead, clicking a
 * row adds a `drift_item` context chip (`chat.addContextChip`, the same
 * affordance as clicking a section on the Spec canvas) which focuses the drift
 * agent on that item via the `[Focus: …]` message prefix. The user resolves or
 * accepts drift by talking to the agent, behind a `render_confirmation` gate.
 *
 * Live updates: re-fetches on every doc-change event so newly-flagged drift
 * appears without a manual refresh.
 */

export function DriftInbox() {
  const [items, setItems] = useState<DriftInboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const chat = useChat();
  // `?doc=std-N` narrows the inbox to a single standard (the drift-badge
  // deep-link). Absent → the full standards inbox.
  const docFilter = searchParams.get('doc');

  const load = useCallback(() => {
    fetchDriftInbox(docFilter ? { doc: docFilter } : undefined)
      .then((next) => {
        // Success clears any prior error (a transient failure self-heals on the
        // next SSE-driven refetch) and seeds the rows.
        setError(null);
        setItems(next);
      })
      .catch((err) => {
        // A no-standards / empty workspace must NOT spin and must NOT show the
        // "all clear" empty state on top of a failure: drop stale rows and
        // surface a non-spinner error state instead. `instanceof Error` guards
        // against a non-Error rejection so reading `.message` never throws.
        setItems([]);
        setError(err instanceof Error ? err.message : String(err));
      })
      // ALWAYS resolve loading — success AND error paths — so the page can never
      // hang on the spinner (the bug this guards against).
      .finally(() => setLoading(false));
  }, [docFilter]);

  useEffect(() => {
    load();
  }, [load]);

  // Same SSE channel the standards / spec boards use — drift comments
  // come from the agent, often via MCP, so we want fresh state without
  // a manual refresh.
  useDocChangeStream(null, load);

  // spec-143 dec-3: clicking a drift row focuses the agent on that item via a
  // minimal context chip — the identical affordance to clicking a section
  // (SectionCard.tsx) or an Issue (IssuePanel.tsx). No richer payload travels
  // through the chip; the agent fetches detail itself and the chip drives the
  // `[Focus: <label>]` message prefix (useAgentGraph.ts).
  const handleFocus = useCallback(
    (item: DriftInboxItem) => {
      const kind = item.commentType === 'plan_revision' ? 'Proposal' : 'Drift';
      // spec-143 i-2: the label carries the item's number — matching the badge
      // the user sees on the row ("Drift #2") — so the `[Focus: …]` prefix
      // names the item unambiguously. The agent's drift context lists each item
      // with its c-N ref and documents that "#N" is c-N, so it can act on the
      // ref directly with no list_comments recovery round-trip.
      const itemNumber = item.commentHandle.replace(/^c-/, '');
      chat.addContextChip({
        type: 'drift_item',
        id: item.commentId,
        label: `${kind} #${itemNumber} on ${item.doc.handle} — ${item.doc.title}`,
      });
    },
    [chat],
  );

  // spec-143 i-2: "Discuss with Agent" doesn't just focus — it kicks off the
  // resolution conversation. The opening message carries the item reference in
  // its TEXT (the chip set alongside it only decorates messages from the NEXT
  // send onwards — React state hasn't flushed for this one), and the chip keeps
  // every follow-up message focused on the item.
  const handleDiscuss = useCallback(
    (item: DriftInboxItem) => {
      handleFocus(item);
      const itemNumber = item.commentHandle.replace(/^c-/, '');
      const prompt =
        item.commentType === 'plan_revision'
          ? `Help me resolve Proposal #${itemNumber} on ${item.doc.handle} ("${item.doc.title}"). Explain what the proposed change does and why it was proposed, give me your read on whether it should be accepted, and walk me through resolving it.`
          : `Help me resolve Drift #${itemNumber} on ${item.doc.handle} ("${item.doc.title}"). Explain what drifted and why it matters, then walk me through the options — change the standard, fix the code, or dismiss the finding.`;
      chat.sendMessage(prompt);
    },
    [chat, handleFocus],
  );

  return (
    // spec-143 t-4 (dec-6): the drift agent comes to life on this page — the
    // controller (rendered once, OUTSIDE the loading branch so it never
    // unmounts/remounts on the load→loaded transition) enters drift mode and
    // fires the opening turn once on mount. It renders nothing.
    <>
      <OpeningDriftController />
      {loading ? (
        <div className="flex justify-center items-center min-h-[50vh]">
          <Spinner />
        </div>
      ) : (
        <DriftInboxBody
          items={items}
          error={error}
          docFilter={docFilter}
          searchParams={searchParams}
          setSearchParams={setSearchParams}
          onFocus={handleFocus}
          onDiscuss={handleDiscuss}
        />
      )}
    </>
  );
}

interface DriftInboxBodyProps {
  items: DriftInboxItem[];
  error: string | null;
  docFilter: string | null;
  searchParams: URLSearchParams;
  setSearchParams: (next: URLSearchParams) => void;
  onFocus: (item: DriftInboxItem) => void;
  onDiscuss: (item: DriftInboxItem) => void;
}

function DriftInboxBody({
  items,
  error,
  docFilter,
  searchParams,
  setSearchParams,
  onFocus,
  onDiscuss,
}: DriftInboxBodyProps) {
  // Deep-link to a specific drift: `?drift=<commentId>` scrolls the matching row
  // into view and gives it a transient rose highlight, so a link into the inbox
  // (e.g. from the Brain knowledge graph's drift edge or card) lands on the EXACT
  // item, not just the doc-filtered list. Complements the existing `?doc=std-N`.
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const [highlightedCommentId, setHighlightedCommentId] = useState<string | null>(null);
  const driftDeepLink = searchParams.get('drift');

  useEffect(() => {
    if (!driftDeepLink) {
      setHighlightedCommentId(null);
      return;
    }
    // Only act once the target row is actually in the loaded list (and mounted).
    if (!items.some((it) => it.commentId === driftDeepLink)) return;
    const el = rowRefs.current.get(driftDeepLink);
    if (!el) return;
    // jsdom has no scrollIntoView — guard so tests never throw. Honour reduced
    // motion (matchMedia is absent in jsdom, so guard that too).
    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView?.({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
    setHighlightedCommentId(driftDeepLink);
    // Transient: clear after ~2s so re-navigating to the same item re-triggers.
    const timer = window.setTimeout(() => setHighlightedCommentId(null), 2000);
    return () => window.clearTimeout(timer);
  }, [driftDeepLink, items]);

  return (
    <div className="h-full flex flex-col px-6 py-6">
      <div className="flex items-center justify-between mb-6 flex-none">
        <div>
          <h1 className="text-2xl font-semibold text-heading">Drift Inbox</h1>
          <p className="text-xs text-muted mt-1">
            Open drift findings and proposed changes across this Memex's Standards.
          </p>
        </div>
        {docFilter && (
          <button
            type="button"
            onClick={() => {
              searchParams.delete('doc');
              setSearchParams(searchParams);
            }}
            className="flex-none text-xs px-2.5 py-1 rounded-full border border-edge bg-card-hover text-secondary hover:text-primary"
            data-testid="drift-filter-chip"
            title="Showing drift for a single standard — click to clear"
          >
            Filtered to <span className="font-mono">{docFilter}</span> · Clear
          </button>
        )}
      </div>

      {error && (
        <div className="bg-status-danger-bg border border-status-danger-border rounded-lg p-4 text-status-danger-text mb-4">
          {error}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto space-y-3">
        {items.length === 0 ? (
          // The error banner above already explains a failed load — don't also
          // show the "all clear" empty state on top of it (it would read as
          // "nothing to triage" when the load actually errored).
          error ? null : (
            <div
              className="border border-edge-subtle rounded-lg p-8 text-center bg-surface/40"
              data-testid="drift-empty-state"
            >
              <p className="text-sm text-secondary mb-1">No open drift or proposals.</p>
              <p className="text-xs text-muted">
                When the agent flags drift on a standard or proposes a change,
                it shows up here for review.
              </p>
            </div>
          )
        ) : (
          items.map((item) => {
            const isProposal = item.commentType === 'plan_revision';
            // The user-facing item number — the comment's per-doc sequence
            // (c-N) without the internal `c-` prefix (spec-143 i-2 feedback:
            // "c-" reads as jargon; the number is what identifies the item).
            const itemNumber = item.commentHandle.replace(/^c-/, '');
            // Drift is standards-only (b-63), so every row links to a Standard.
            // tenantPath keeps the link under the current /:ns/:mx (a bare
            // /standards/... would drop the tenant prefix).
            const docHref = tenantPath(`/standards/${item.doc.handle}`);
            // The source decision's canonical URL — only when its owning spec is
            // known (there's no decision route without a spec); else no link.
            const decHref = item.decision?.specHandle
              ? tenantPath(`/specs/${item.decision.specHandle}/decisions/${item.decision.handle}`)
              : null;
            return (
              <div
                key={item.commentId}
                ref={(el) => {
                  if (el) rowRefs.current.set(item.commentId, el);
                  else rowRefs.current.delete(item.commentId);
                }}
                onClick={() => onFocus(item)}
                className={`border rounded-md bg-panel p-4 cursor-pointer hover:border-edge hover:bg-card-hover transition-colors ${
                  highlightedCommentId === item.commentId
                    ? 'border-edge-subtle ring-2 ring-status-danger-border'
                    : 'border-edge-subtle'
                }`}
                data-testid="drift-inbox-row"
                data-comment-id={item.commentId}
                data-comment-type={item.commentType}
                data-row-type={isProposal ? 'proposal' : 'observation'}
                data-highlighted={highlightedCommentId === item.commentId ? 'true' : undefined}
                title="Focus the drift agent on this item"
              >
                {/* Meta row: the type badge (carries the c-N ref the agent acts
                    on) on the left; opened-ago + Discuss on the right. */}
                <div className="flex items-center justify-between gap-3 mb-2">
                  <span
                    className={
                      item.commentType === 'drift'
                        ? 'flex-none whitespace-nowrap px-2 py-0.5 rounded-full bg-status-danger-bg text-status-danger-text border border-status-danger-border text-xs font-medium'
                        : 'flex-none whitespace-nowrap px-2 py-0.5 rounded-full bg-status-info-bg text-status-info-text border border-status-info-border text-xs font-medium'
                    }
                    title={`Item #${itemNumber} — use this number to refer to the item when discussing it with the agent`}
                  >
                    {item.commentType === 'drift' ? 'Drift' : 'Proposed change'}{' '}
                    <span data-testid="drift-comment-handle">#{itemNumber}</span>
                  </span>
                  <div className="flex items-center gap-3 flex-none">
                    <span className="text-xs text-muted whitespace-nowrap">
                      opened {timeAgo(item.createdAt)}
                    </span>
                    {/* spec-143 i-2: kicks off the resolution conversation —
                        focuses the agent on the item AND sends the opening
                        "help me resolve this" message (dec-3's no-mutation-
                        buttons rule is untouched; any actual mutation still
                        goes through the agent's render_confirmation gate). */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDiscuss(item);
                      }}
                      className="flex-none whitespace-nowrap text-xs px-2.5 py-1 rounded-full border border-edge bg-card-hover text-secondary hover:text-primary hover:border-accent transition-colors"
                      data-testid="drift-discuss-button"
                      title={`Focus the agent on item #${itemNumber}`}
                    >
                      Discuss with Agent
                    </button>
                  </div>
                </div>

                {/* The important information, drift-card style. A drift reads as a
                    relationship (decision ✗ contradicts standard); a proposal is a
                    one-liner. Neither dumps the full comment body / diff (spec-498
                    — too much to read in a list; the agent explains on Discuss). */}
                {isProposal ? (
                  <>
                    <div
                      className="flex items-baseline gap-1.5 text-sm min-w-0"
                      data-testid="drift-proposal-summary"
                    >
                      <span className="flex-none text-muted">Proposes a change to</span>
                      <Link
                        to={docHref}
                        onClick={(e) => e.stopPropagation()}
                        className="flex-none font-mono text-secondary hover:underline"
                      >
                        {item.doc.handle}
                      </Link>
                      <span className="truncate text-secondary">{item.doc.title}</span>
                    </div>
                    {/* spec-530 t-7: the before/after this row has promised since
                        spec-143 and never delivered. Read-only — spec-143 dec-3's
                        no-action-buttons rule stands. */}
                    <ProposalDisclosure proposal={item.proposal ?? null} />
                  </>
                ) : (
                  <div className="space-y-1 text-sm" data-testid="drift-observation-body">
                    {item.decision ? (
                      <>
                        <div
                          className="flex items-baseline gap-1.5 min-w-0"
                          data-testid="drift-decision"
                        >
                          {decHref ? (
                            <Link
                              to={decHref}
                              onClick={(e) => e.stopPropagation()}
                              className="flex-none font-mono text-muted hover:underline"
                              data-testid="drift-decision-link"
                            >
                              {item.decision.handle}
                            </Link>
                          ) : (
                            <span className="flex-none font-mono text-muted">
                              {item.decision.handle}
                            </span>
                          )}
                          <span className="truncate text-secondary">{item.decision.title}</span>
                        </div>
                        <div
                          className="text-xs font-medium text-status-danger-text"
                          data-testid="drift-contradicts"
                        >
                          ✗ contradicts
                        </div>
                        <div
                          className="flex items-baseline gap-1.5 min-w-0"
                          data-testid="drift-standard"
                        >
                          <Link
                            to={docHref}
                            onClick={(e) => e.stopPropagation()}
                            className="flex-none font-mono text-secondary hover:underline"
                          >
                            {item.doc.handle}
                          </Link>
                          <span className="truncate text-secondary">{item.doc.title}</span>
                        </div>
                      </>
                    ) : (
                      // Legacy drift with no linked decision: show the standard it's
                      // on and a clamped finding — never the full body.
                      <>
                        <div
                          className="flex items-baseline gap-1.5 min-w-0"
                          data-testid="drift-standard"
                        >
                          <Link
                            to={docHref}
                            onClick={(e) => e.stopPropagation()}
                            className="flex-none font-mono text-secondary hover:underline"
                          >
                            {item.doc.handle}
                          </Link>
                          <span className="truncate text-secondary">{item.doc.title}</span>
                        </div>
                        <div className="text-xs text-muted line-clamp-2">{item.content}</div>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
