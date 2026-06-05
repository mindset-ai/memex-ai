// IssuePanel — Issues tab on a Spec view, a first-class peer to AC / Tasks /
// Decisions / Comments (spec-112 t-10).
//
// An Issue is a bug or a todo raised against the Spec AS A WHOLE — any phase,
// no anchor (ac-1). The panel lists Issues by their per-Spec `issue-N` handle, lets
// a human register a new Issue, and stays live over SSE: it subscribes to the
// same doc-change bus every other panel uses, so a create/update/delete from
// any source (React UI, MCP, the agent, REST) re-renders the list (ac-2).
//
// Card interaction (spec-164 dec-4): clicking a card toggles an INLINE
// expansion — full body + metadata in place, click again to collapse, several
// cards may be open at once (the spec-96 dec-16 accordion pattern). The
// click-to-focus chip (c-1) now fires ONLY from the dedicated hover icon:
// it drops a MINIMAL {type:'issue', id, label:'issue-N — title'} ContextChip
// into the shared chat store — the agent fetches detail via get_issue.
//
// Bidirectional bridge affordances (s-5): "Convert to Task" (Issue → Task,
// down-bridge ac-20) surfaces on every open Issue. The Task → Issue up-bridge
// (ac-30) is an agent/MCP path keyed on a Task, surfaced from TaskPanel; here
// we mark the converted/resolved lineage on the Issue card.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Issue, IssueType, IssueStatus } from '../api/types';
import {
  fetchIssues,
  createIssueApi,
  updateIssueStatusApi,
  convertIssueToTaskApi,
} from '../api/client';
import { useChat } from './ChatContext';
import { useDocChangeStream } from '../hooks/useDocChangeStream';
import { Badge, Button } from './ui';
import { Input } from './ui/Input';
import { TextArea } from './ui/TextArea';

interface IssuePanelProps {
  docId: string;
  /** spec-111-style read gate: when false (non-member reading a public Memex),
   *  every mutation control is suppressed; the list stays readable. */
  canWrite?: boolean;
  /**
   * spec-182 dec-4: the posture gate for issue DISPOSITIONS. Registering an
   * issue stays on canWrite (raising concerns is the reviewer's job); the two
   * dispositions — Convert to Task and Won't fix — are editor calls and gate
   * here. Defaults to true so legacy call sites keep today's behaviour.
   */
  canEdit?: boolean;
  /** Bubble up after a mutation so the rest of the spec view (counts, etc.)
   *  picks up related changes. */
  onUpdate?: () => void;
  /** spec-64 i-3: an `issue-N` handle to scroll into view + briefly highlight when
   *  the panel opens via the `specs/:id/issues/:issueId` deep-link (mirrors
   *  DecisionPanel's highlightDecisionHandle). Best-effort: a handle that doesn't
   *  match any loaded issue is a no-op. */
  highlightIssueHandle?: string | null;
}

const TYPE_LABEL: Record<IssueType, string> = { bug: 'bug', todo: 'todo' };

// Status → Badge status token. `open` reads as a live task; converted /
// resolved / wont_fix wind down the visual weight.
const STATUS_BADGE: Record<IssueStatus, string> = {
  open: 'in_progress',
  converted: 'archived',
  resolved: 'complete',
  wont_fix: 'archived',
};

const STATUS_LABEL: Record<IssueStatus, string> = {
  open: 'open',
  converted: 'converted',
  resolved: 'resolved',
  wont_fix: "won't fix",
};

// `issue-N — title` is the chip label per c-1. Kept short; the agent calls
// get_issue for the body.
function chipLabel(issue: Issue): string {
  return `issue-${issue.seq} — ${issue.title}`;
}

export function IssuePanel({
  docId,
  canWrite = true,
  canEdit = true,
  onUpdate,
  highlightIssueHandle,
}: IssuePanelProps) {
  const chat = useChat();
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  // spec-164 dec-4: inline accordion — ids of the cards currently expanded.
  // A Set so several issues can be read side by side (mirrors DecisionPanel's
  // collapse state, inverted: cards start collapsed).
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const [showForm, setShowForm] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newBody, setNewBody] = useState('');
  const [newType, setNewType] = useState<IssueType>('bug');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const rows = await fetchIssues(docId);
      setIssues(rows);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [docId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live over SSE (ac-2): the doc-change bus carries entity:'issue' mutations
  // (created/updated/deleted) on this Spec — refetch so a create/update/delete
  // from any source renders without a manual reload. Same hook every other
  // panel uses (s-4 — no new transport).
  useDocChangeStream(docId, load);

  // spec-64 i-3: `issue-N` deep-link (from the ⌘K palette via
  // `specs/:id/issues/:issueId`) — scroll the matching issue card into view and
  // pulse a highlight ring for ~2s. Mirrors DecisionPanel's highlight effect.
  // Re-runs when the handle or the loaded issues change (e.g. SSE refetch).
  useEffect(() => {
    if (!highlightIssueHandle || !issues) return;
    const m = highlightIssueHandle.match(/^issue-(\d+)$/i);
    if (!m) return;
    const seq = Number(m[1]);
    const target = issues.find((i) => i.seq === seq);
    if (!target) return;

    // Defer a tick so the list has rendered the matching card.
    const handle = window.setTimeout(() => {
      const card = panelRef.current?.querySelector<HTMLElement>(
        `[data-issue-seq="issue-${seq}"]`,
      );
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setHighlightedId(target.id);
      // spec-164 ac-21: a deep-linked issue lands already expanded.
      setExpandedIds((prev) => (prev.has(target.id) ? prev : new Set(prev).add(target.id)));
      window.setTimeout(() => setHighlightedId(null), 2000);
    }, 0);
    return () => window.clearTimeout(handle);
  }, [highlightIssueHandle, issues]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;
    setCreating(true);
    try {
      // No anchor, no phase guard (ac-1): the Issue is registered against the
      // Spec as a whole. The server mints the issue-N; the SSE refetch above will
      // pull the new row in, but reload eagerly so the author sees it at once.
      await createIssueApi(docId, newTitle.trim(), newBody.trim(), newType);
      setNewTitle('');
      setNewBody('');
      setNewType('bug');
      setShowForm(false);
      await load();
      onUpdate?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const handleFocus = useCallback(
    (issue: Issue) => {
      // Minimal chip per c-1 — id + issue-N — title label, nothing more.
      chat.addContextChip({ type: 'issue', id: issue.id, label: chipLabel(issue) });
    },
    [chat],
  );

  const handleConvert = async (issue: Issue) => {
    try {
      await convertIssueToTaskApi(issue.id);
      await load();
      onUpdate?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleStatus = async (issue: Issue, status: IssueStatus) => {
    try {
      await updateIssueStatusApi(issue.id, status);
      await load();
      onUpdate?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (issues === null) {
    return <div className="px-2 py-10 text-sm text-muted">Loading issues…</div>;
  }

  const open = issues.filter((i) => i.status === 'open');
  const other = issues.filter((i) => i.status !== 'open');

  return (
    <div ref={panelRef} data-testid="issue-panel" className="border rounded-lg p-5 border-edge bg-panel">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-heading uppercase tracking-wider">
          Issues
        </h3>
        <span className="text-xs text-muted">
          {open.length} open, {other.length} closed
        </span>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-status-danger-border bg-status-danger-bg px-3 py-2 text-xs text-status-danger-text">
          {error}
        </div>
      )}

      {issues.length === 0 && (
        <p className="text-sm text-muted mb-4">
          No issues yet. Raise a bug or a todo against this Spec — it can be
          registered against the Spec as a whole, at any phase, with no anchor.
        </p>
      )}

      <div className="space-y-2 mb-4">
        {[...open, ...other].map((issue) => {
          const isExpanded = expandedIds.has(issue.id);
          return (
          <div
            key={issue.id}
            data-testid="issue-card"
            data-issue-seq={`issue-${issue.seq}`}
            data-issue-type={issue.type}
            data-issue-status={issue.status}
            data-expanded={isExpanded || undefined}
            aria-expanded={isExpanded}
            onClick={() => toggleExpanded(issue.id)}
            className={`group/issue px-3 py-2.5 rounded-md border cursor-pointer transition-colors bg-surface/50 hover:bg-card-hover ${
              highlightedId === issue.id ? 'ring-2 ring-accent border-accent' : 'border-edge-subtle'
            }`}
          >
            <div className="flex items-start gap-3">
              <span className="flex-none text-xs font-mono text-muted pt-0.5">
                issue-{issue.seq}
              </span>
              <button
                data-testid="issue-focus"
                onClick={(e) => {
                  e.stopPropagation();
                  handleFocus(issue);
                }}
                className="flex-none opacity-0 group-hover/issue:opacity-100 transition-opacity p-0.5 rounded hover:bg-card-hover -ml-1"
                title="Focus chat on this issue"
              >
                <svg className="w-3 h-3 text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
                </svg>
              </button>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <Badge
                    status={issue.type === 'bug' ? 'blocked' : 'archived'}
                    label={TYPE_LABEL[issue.type]}
                  />
                  <Badge status={STATUS_BADGE[issue.status]} label={STATUS_LABEL[issue.status]} />
                  {issue.severity && (
                    <span className="text-[11px] text-muted">{issue.severity}</span>
                  )}
                  <span className="text-sm truncate text-primary">{issue.title}</span>
                </div>
                {issue.body && !isExpanded && (
                  <p className="text-xs text-muted mt-1 line-clamp-2">{issue.body}</p>
                )}
                {isExpanded && (
                  // spec-164 dec-4: the inline expansion — full body (no
                  // clamp) + the metadata line. Read in place; click the
                  // card again to collapse.
                  <div data-testid="issue-expanded" className="mt-2 space-y-2">
                    {issue.body && (
                      <p className="text-xs text-body whitespace-pre-wrap">{issue.body}</p>
                    )}
                    <p className="text-[11px] text-muted">
                      issue-{issue.seq} · {TYPE_LABEL[issue.type]} ·{' '}
                      {STATUS_LABEL[issue.status]}
                      {issue.severity ? <> · severity {issue.severity}</> : null} · raised{' '}
                      {new Date(issue.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                )}
              </div>
              {/* spec-182 dec-4: dispositions are editor calls — canEdit on top
                  of the spec-111 read gate (canWrite false suppresses everything). */}
              {canWrite && canEdit && issue.status === 'open' && (
                <div className="flex-none flex items-center gap-2">
                  <Button
                    data-testid="issue-convert"
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleConvert(issue);
                    }}
                    title="Convert this Issue into a Task (spawns a verifying AC)"
                  >
                    Convert to Task
                  </Button>
                  <Button
                    data-testid="issue-wontfix"
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleStatus(issue, 'wont_fix');
                    }}
                  >
                    Won't fix
                  </Button>
                </div>
              )}
            </div>
          </div>
          );
        })}
      </div>

      {canWrite && (showForm ? (
        <form onSubmit={handleCreate} className="space-y-2" data-testid="issue-form">
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="issue-type-bug"
              data-active={newType === 'bug' ? 'true' : 'false'}
              onClick={() => setNewType('bug')}
              className={`text-xs px-2 py-0.5 rounded-md border transition-colors ${
                newType === 'bug' ? 'bg-accent text-white border-accent' : 'bg-overlay text-secondary border-edge'
              }`}
            >
              Bug
            </button>
            <button
              type="button"
              data-testid="issue-type-todo"
              data-active={newType === 'todo' ? 'true' : 'false'}
              onClick={() => setNewType('todo')}
              className={`text-xs px-2 py-0.5 rounded-md border transition-colors ${
                newType === 'todo' ? 'bg-accent text-white border-accent' : 'bg-overlay text-secondary border-edge'
              }`}
            >
              Todo
            </button>
          </div>
          <Input
            type="text"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Issue title..."
            inputSize="compact"
            autoFocus
            aria-label="Issue title"
          />
          <TextArea
            value={newBody}
            onChange={(e) => setNewBody(e.target.value)}
            placeholder="What's the bug / todo? (enough for an agent to act on it)..."
            rows={2}
            textAreaSize="compact"
            aria-label="Issue body"
          />
          <div className="flex gap-2">
            <Button type="submit" disabled={creating || !newTitle.trim()} size="sm">
              Register issue
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setShowForm(false);
                setNewTitle('');
                setNewBody('');
                setNewType('bug');
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <button
          data-testid="issue-add"
          onClick={() => setShowForm(true)}
          className="text-sm text-secondary hover:text-primary"
        >
          + Register issue
        </button>
      ))}
    </div>
  );
}
