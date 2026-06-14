import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './ui';
import { useAuth } from './AuthContext';
import { moveDocApi, type MembershipSummary } from '../api/client';
import { getCurrentTenant, tenantPathFor } from '../utils/tenantUrl';

interface MoveSpecDialogProps {
  docId: string;
  title: string;
  // Optional pre-computed counts so the dialog can show what will travel.
  decisionCount?: number;
  taskCount?: number;
  commentCount?: number;
  onClose: () => void;
  // Called after a successful move, before the window redirects. Lets the caller clear
  // local state (e.g. remove the card from the kanban) in case the navigation is delayed.
  onMoved?: (result: { newHandle: string; subdomain: string | null }) => void;
}

// Dialog for moving a Spec to a different Memex. Destination is any Memex the user
// is an active member of besides the current one. spec-293 (dec-2/dec-3): a Spec moves
// WHOLE — every artifact and ALL comments travel with it — so there are no per-artifact
// opt-outs; the dialog just shows what will move. Public share links are revoked.
export function MoveSpecDialog({
  docId,
  title,
  decisionCount,
  taskCount,
  commentCount,
  onClose,
  onMoved,
}: MoveSpecDialogProps) {
  const { session } = useAuth();
  const currentTenant = getCurrentTenant();
  const currentNamespace = currentTenant?.namespace ?? null;
  const currentMemexSlug = currentTenant?.memex ?? null;

  const destinations = useMemo<MembershipSummary[]>(() => {
    if (!session) return [];
    if (currentNamespace === null) return []; // not in a tenant — refuse all
    return session.memberships.filter((m) => {
      // Exclude only the exact memex we're currently on. A namespace slug is
      // shared by every memex in an org, so matching on slug alone would drop
      // all the org's other memexes — match on (namespace + memex) instead, the
      // same key MemexSwitcher uses to identify the current memex.
      if (
        m.slug === currentNamespace &&
        (m.memexSlug ?? null) === currentMemexSlug
      ) {
        return false;
      }
      // Move requires write access on the destination; visited (read-only)
      // memexes can't be move targets. Read-only is opt-in via an explicit
      // 'read'/'visited' — an absent accessLevel means full access (std-4).
      if (m.accessLevel === 'read' || m.source === 'visited') return false;
      return true;
    });
  }, [session, currentNamespace, currentMemexSlug]);

  const [targetMemexId, setTargetMemexId] = useState<string>(
    destinations[0]?.memexId ?? '',
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !submitting) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, submitting]);

  // Keep a valid destination selected once the membership list resolves (the
  // session can load after mount, leaving the initial state empty).
  useEffect(() => {
    if (destinations.length === 0) return;
    if (!destinations.some((m) => m.memexId === targetMemexId)) {
      setTargetMemexId(destinations[0].memexId);
    }
  }, [destinations, targetMemexId]);

  const chosen = destinations.find((m) => m.memexId === targetMemexId);

  async function handleMove() {
    if (!chosen) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await moveDocApi(docId, {
        targetMemexId: chosen.memexId,
      });

      // Compose a toast-worthy message if deps were pruned or share tokens revoked. We
      // stash it in sessionStorage so the destination page can show it after the cross-
      // origin redirect completes.
      const notes: string[] = [];
      if (result.removedDecisionDeps + result.removedTaskDeps > 0) {
        const total = result.removedDecisionDeps + result.removedTaskDeps;
        notes.push(`${total} blocker link${total === 1 ? '' : 's'} removed (cross-memex)`);
      }
      if (result.revokedShareTokens > 0) {
        notes.push(
          `${result.revokedShareTokens} share link${result.revokedShareTokens === 1 ? '' : 's'} revoked`,
        );
      }
      const flash = `Moved to ${chosen.name}. New handle: ${result.newHandle}.${
        notes.length ? ` ${notes.join('. ')}.` : ''
      }`;
      try {
        sessionStorage.setItem('memex-flash', flash);
      } catch {
        /* non-fatal if storage is blocked */
      }

      const subdomain = chosen.kind === 'team' ? chosen.slug : null;
      onMoved?.({ newHandle: result.newHandle, subdomain });

      const ns = chosen.slug;
      const mx = chosen.memexSlug ?? (chosen.kind === 'personal' ? 'personal' : 'main');
      // Per doc-30 dec-4 (post-b-105 rename): specs route at /specs/:handle.
      // MoveSpecDialog is spec-only by definition (the dialog name and the API
      // endpoint enforce it), so unconditional /specs/ is correct.
      window.location.href = tenantPathFor(ns, mx, `/specs/${result.newHandle}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div
        data-testid="move-spec-dialog"
        className="w-full max-w-lg rounded-xl border border-edge bg-panel shadow-2xl"
      >
        <div className="px-6 py-4 border-b border-edge flex items-center justify-between">
          <h2 className="text-base font-semibold text-heading">Move spec</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="text-muted hover:text-primary transition-colors disabled:opacity-50"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-6 space-y-5">
          <p className="text-sm text-secondary">
            Move <span className="font-medium text-primary">{title}</span> to another Memex.
          </p>

          {destinations.length === 0 ? (
            <div className="text-sm text-muted bg-overlay rounded-md p-3 border border-edge-subtle">
              You don&apos;t have access to another Memex. Create an Org or accept an invite to
              move specs between Memexes.
            </div>
          ) : (
            <>
              <div>
                <label className="block text-xs font-medium uppercase tracking-wider text-muted mb-2">
                  Destination
                </label>
                <select
                  value={targetMemexId}
                  onChange={(e) => setTargetMemexId(e.target.value)}
                  disabled={submitting}
                  className="w-full bg-input border border-edge text-primary rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-edge-strong"
                >
                  {destinations.map((m) => (
                    <option key={m.memexId} value={m.memexId}>
                      {m.name} {m.kind === 'personal' ? '(personal)' : `· ${m.memexSlug}`}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-2">
                <div className="text-xs font-medium uppercase tracking-wider text-muted">
                  What moves
                </div>
                <ul className="text-sm text-secondary space-y-1">
                  <li>
                    The whole Spec — its sections, ACs, QA report, issues, members and
                    assignees.
                  </li>
                  <li>
                    <MovePart label="Decisions" count={decisionCount} />
                    {', '}
                    <MovePart label="Tasks" count={taskCount} />
                    {' and '}
                    <MovePart label="Comments" count={commentCount} />
                    {' travel with it.'}
                  </li>
                </ul>
                <p className="text-xs text-muted pt-1">
                  The Spec&apos;s handle changes in the destination, and public share links
                  are revoked.
                </p>
              </div>
            </>
          )}

          {error && (
            <div className="text-sm text-status-danger-text bg-status-danger-bg border border-status-danger-border rounded-md p-3">
              {error}
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-edge flex items-center justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleMove}
            disabled={submitting || !chosen}
          >
            {submitting ? 'Moving…' : 'Move'}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// Renders "<count> <label>" when a count is known, else just the label — used in
// the read-only "what moves" summary.
function MovePart({ label, count }: { label: string; count?: number }) {
  return (
    <span className="text-primary">
      {typeof count === 'number' ? `${count} ` : ''}
      {label}
    </span>
  );
}
