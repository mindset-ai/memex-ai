import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { fetchDriftInbox, type DriftInboxItem } from '../api/client';
import { useDocChangeStream } from '../hooks/useDocChangeStream';
import { useChat } from '../components/ChatContext';
import { formatDate } from '../utils/format';
import { Spinner } from '../components/Spinner';
import { MarkdownText } from '../components/chat/MarkdownText';
import { OpeningDriftController } from '../components/chat/OpeningDriftController';

/**
 * Standards Drift Inbox (t-10 of doc-8; scoped to Standards in b-63). Surfaces
 * every open `drift` and `plan_revision` typed comment on a Standard with
 * parent doc context, so standard owners see everything that needs review in
 * one place. Drift is a standards-only concept, so every row links to a
 * Standard. An optional `?doc=std-N` query param (the per-standard drift-badge
 * deep-link) narrows the inbox to a single standard.
 *
 * Two explicit row types (spec-143 dec-2):
 *   - Observation (`drift`) — the repo has diverged from the rule; a finding,
 *     not a proposed edit. Rendered as a compact single-block statement.
 *   - Proposal (`plan_revision`) — a proposed change to the standard, ALWAYS
 *     rendered as a before/after diff (current section content vs the server-
 *     normalized `proposedContent`). The server guarantees `proposedContent` is
 *     non-null for every proposal (even unfenced ones), so no row ever falls
 *     through to an undifferentiated markdown blob.
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
            // Two explicit row types (dec-2): a `plan_revision` is a proposal
            // (always a before/after diff via the server-normalized
            // proposedContent); a `drift` is an observation (no diff).
            const isProposal = item.commentType === 'plan_revision';
            // The user-facing item number — the comment's per-doc sequence
            // (c-N) without the internal `c-` prefix (spec-143 i-2 feedback:
            // "c-" reads as jargon; the number is what identifies the item).
            const itemNumber = item.commentHandle.replace(/^c-/, '');
            // Drift is standards-only (b-63), so every row links to a Standard.
            const docHref = `/standards/${item.doc.handle}`;
            return (
              <div
                key={item.commentId}
                onClick={() => onFocus(item)}
                className="border border-edge-subtle rounded-md bg-panel p-4 cursor-pointer hover:border-edge hover:bg-card-hover transition-colors"
                data-testid="drift-inbox-row"
                data-comment-type={item.commentType}
                data-row-type={isProposal ? 'proposal' : 'observation'}
                title="Focus the drift agent on this item"
              >
                {/* min-w-0 on the left cluster lets the TITLE truncate instead
                    of forcing the pill / handles / button to wrap mid-token. */}
                <div className="flex items-center justify-between gap-3 mb-2">
                  <div className="flex items-center gap-2 text-xs min-w-0">
                    {/* spec-143 i-2: the item's number lives INSIDE the type
                        badge so it clearly numbers this inbox item ("Drift #2").
                        It's the comment's per-doc sequence on the Standard
                        (c-N) — the ref the agent acts on. */}
                    <span
                      className={
                        item.commentType === 'drift'
                          ? 'flex-none whitespace-nowrap px-2 py-0.5 rounded-full bg-status-danger-bg text-status-danger-text border border-status-danger-border font-medium'
                          : 'flex-none whitespace-nowrap px-2 py-0.5 rounded-full bg-status-info-bg text-status-info-text border border-status-info-border font-medium'
                      }
                      title={`Item #${itemNumber} — use this number to refer to the item when discussing it with the agent`}
                    >
                      {item.commentType === 'drift' ? 'Drift' : 'Proposed change'}{' '}
                      <span data-testid="drift-comment-handle">#{itemNumber}</span>
                    </span>
                    <Link
                      to={docHref}
                      onClick={(e) => e.stopPropagation()}
                      className="flex-none whitespace-nowrap font-mono text-secondary hover:underline"
                    >
                      {item.doc.handle}
                    </Link>
                    {/* min-w-0 lets the title WRAP within the flex row instead
                        of truncating or forcing the fixed tokens to break. */}
                    <span className="text-muted break-words min-w-0">
                      {item.doc.title}
                    </span>
                    {item.section && (
                      <span className="flex-none whitespace-nowrap text-muted">
                        · section{' '}
                        <span className="font-mono">{item.section.sectionType}</span>
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 flex-none">
                    <span className="text-xs text-muted whitespace-nowrap">
                      {item.authorName}
                      {item.source ? ` (${item.source})` : ''} ·{' '}
                      {formatDate(item.createdAt)}
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

                {isProposal ? (
                  <div
                    className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3"
                    data-testid="drift-proposal-diff"
                  >
                    <div>
                      <div className="text-xs uppercase tracking-wide text-muted mb-1">
                        Current section content
                      </div>
                      <div className="text-xs bg-surface/60 border border-edge-subtle rounded p-2 break-words">
                        {item.section?.content ? (
                          <MarkdownText inline={false}>
                            {item.section.content}
                          </MarkdownText>
                        ) : (
                          <span className="text-muted">(no current content)</span>
                        )}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-wide text-muted mb-1">
                        Proposed
                      </div>
                      <div className="text-xs bg-surface/60 border border-status-info-border rounded p-2 break-words">
                        <MarkdownText inline={false}>
                          {item.proposedContent ?? item.content}
                        </MarkdownText>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div data-testid="drift-observation-body">
                    <MarkdownText inline={false} className="text-sm text-secondary">
                      {item.content}
                    </MarkdownText>
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
