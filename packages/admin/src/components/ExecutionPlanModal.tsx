import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { rehypeRefLinkifier } from './chat/refLinkifier';
import {
  fetchDoc,
  fetchTaskComments,
  updateDocStatus,
  createComment,
} from '../api/client';
import type { DocWithGraph, Comment, Task } from '../api/types';
import { useAuth } from './AuthContext';
import { Button } from './ui';
import { TextArea } from './ui/TextArea';

// ── ExecutionPlanModal (doc-10 t-17) ─────────────────────────
// Renders a task's linked execution plan (docType='execution_plan') in a portal
// modal. The plan is a regular document, so we fetch it via the existing /api/docs/:id
// endpoint. Readiness lives as a typed comment on the task (per dec-26 — submitted
// by the agent via create_doc(docType:'execution_plan', readinessAssessment)), so we
// additionally fetch the task's readiness_check comments and surface the most recent
// one as a banner.
//
// Approve → flip the plan doc status to 'approved' (real terminal state added in
// t-20 W-B; documents.status CHECK now includes it alongside draft|review|
// implementation|done). Request Changes → post a typed comment on the plan's first
// section with type='plan_revision'. Both actions notify the parent via onUpdate so
// the TaskPanel badge refreshes.

interface ExecutionPlanModalProps {
  task: Task;
  planDocId: string;
  onClose: () => void;
  onUpdate?: () => void;
}

// Map plan + readiness comment + plan status to one of the five product-level
// badge states. Null = no executionPlanDocId on the task.
export type PlanBadgeState = 'submitted' | 'ready' | 'not_ready' | 'approved';

export function derivePlanBadgeState(
  plan: { status: string } | null,
  latestReadinessContent: string | null,
): PlanBadgeState {
  // 'approved' is the canonical post-t-20 terminal state. 'done' is preserved as
  // an alias so plans approved before the schema migration still surface as
  // Approved in the UI rather than reverting to Submitted.
  if (plan?.status === 'approved' || plan?.status === 'done') return 'approved';
  if (latestReadinessContent) {
    const head = latestReadinessContent.trim().toUpperCase();
    if (head.startsWith('NOT READY')) return 'not_ready';
    if (head.startsWith('READY')) return 'ready';
  }
  return 'submitted';
}

const PLAN_STATE_LABEL: Record<PlanBadgeState | 'none', string> = {
  none: 'No plan',
  submitted: 'Submitted',
  ready: 'READY',
  not_ready: 'NOT READY',
  approved: 'Approved',
};

// Tailwind class fragments for each badge state. Centralised so the badge in
// TaskPanel and the banner in this modal stay in sync.
export const PLAN_STATE_CLASSES: Record<PlanBadgeState | 'none', string> = {
  none: 'bg-surface/50 text-muted border-edge',
  submitted: 'bg-status-info-bg text-status-info-text border-status-info-border',
  ready: 'bg-status-success-bg text-status-success-text border-status-success-border',
  not_ready:
    'bg-status-warning-bg text-status-warning-text border-status-warning-border',
  approved:
    'bg-status-success-bg text-status-success-text border-status-success-border',
};

export function planStateLabel(state: PlanBadgeState | 'none'): string {
  return PLAN_STATE_LABEL[state];
}

export function ExecutionPlanModal({
  task,
  planDocId,
  onClose,
  onUpdate,
}: ExecutionPlanModalProps) {
  const { user } = useAuth();
  const [plan, setPlan] = useState<DocWithGraph | null>(null);
  const [readiness, setReadiness] = useState<Comment | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [requestMode, setRequestMode] = useState(false);
  const [revisionText, setRevisionText] = useState('');
  const [busy, setBusy] = useState(false);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [planDoc, readinessComments] = await Promise.all([
        fetchDoc(planDocId),
        fetchTaskComments(task.id, 'readiness_check'),
      ]);
      setPlan(planDoc);
      // Most recent readiness_check comment wins. listTaskComments orders ASC by
      // createdAt, so the last entry is the freshest.
      const latest =
        readinessComments.length > 0
          ? readinessComments[readinessComments.length - 1]
          : null;
      setReadiness(latest);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [planDocId, task.id]);

  useEffect(() => {
    reload();
  }, [reload]);

  const badgeState = derivePlanBadgeState(plan, readiness?.content ?? null);

  const handleApprove = async () => {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      // t-20 W-B: documents.status CHECK now includes 'approved' as a distinct
      // terminal state, so the approve flow writes the literal value the badge
      // derivation reads back. 'done' is still accepted by the badge derivation
      // for backwards compatibility with plans approved before the migration.
      await updateDocStatus(plan.id, 'approved');
      await reload();
      onUpdate?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRequestChanges = async () => {
    if (!plan || !revisionText.trim()) return;
    const firstSection = plan.sections[0];
    if (!firstSection) {
      setError('Plan has no sections to comment on.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createComment(
        firstSection.id,
        user?.name || user?.email || 'Reviewer',
        revisionText.trim(),
        { type: 'plan_revision' },
      );
      setRevisionText('');
      setRequestMode(false);
      onUpdate?.();
      // Stay open — the user can then approve later if they like.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      data-testid="execution-plan-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-[760px] max-h-[88vh] flex flex-col rounded-xl border border-edge bg-panel shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-edge">
          <div className="flex items-center gap-3 min-w-0">
            <h2 className="text-sm font-semibold text-heading truncate">
              Execution plan · t-{task.seq} · {task.title}
            </h2>
            <span
              data-testid="plan-banner-badge"
              className={`px-2 py-0.5 rounded-full text-[11px] font-medium border ${PLAN_STATE_CLASSES[badgeState]}`}
            >
              {PLAN_STATE_LABEL[badgeState]}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-muted hover:text-primary hover:bg-overlay transition-colors"
            aria-label="Close"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 min-h-0 space-y-5">
          {loading && (
            <p className="text-sm text-muted py-8 text-center">Loading execution plan…</p>
          )}

          {error && (
            <div
              data-testid="plan-error"
              className="rounded-md border border-status-error-border bg-status-error-bg p-3 text-sm text-status-error-text"
            >
              {error}
            </div>
          )}

          {!loading && plan && (
            <>
              {readiness && (
                <div
                  data-testid="plan-readiness"
                  className={`rounded-md border p-3 text-sm ${PLAN_STATE_CLASSES[badgeState]}`}
                >
                  <div className="text-[11px] uppercase tracking-wider font-semibold mb-1 opacity-80">
                    Readiness assessment (agent)
                  </div>
                  <div className="prose prose-sm prose-invert max-w-none whitespace-pre-wrap break-words text-sm">
                    {readiness.content}
                  </div>
                </div>
              )}

              {/* The 4 standardised plan sections (t-3 / dec-13). They always exist
                  on a freshly created plan — content may be empty markdown. */}
              {plan.sections.map((section) => (
                <section
                  key={section.id}
                  data-testid={`plan-section-${section.sectionType}`}
                  data-section-type={section.sectionType}
                  className="border-t border-edge first:border-t-0 pt-4 first:pt-0"
                >
                  <h3 className="text-sm font-semibold text-heading mb-2">
                    {section.title || section.sectionType}
                  </h3>
                  {section.content.trim().length === 0 ? (
                    <p className="text-xs text-muted italic">— Empty —</p>
                  ) : (
                    <div className="prose prose-sm prose-invert max-w-none text-sm
                      [&>*:first-child]:mt-0 [&>*:last-child]:mb-0
                      [&_p]:my-2 [&_ul]:my-2 [&_ol]:my-2 [&_li]:my-0.5
                      [&_h1]:mt-4 [&_h1]:mb-2 [&_h2]:mt-3 [&_h2]:mb-2 [&_h3]:mt-2 [&_h3]:mb-1
                      [&_pre]:my-2">
                      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRefLinkifier]}>{section.content}</ReactMarkdown>
                    </div>
                  )}
                </section>
              ))}

              {requestMode && (
                <div data-testid="plan-revision-form" className="border-t border-edge pt-4 space-y-2">
                  <label className="block text-xs font-medium text-secondary">
                    Request changes (creates a plan_revision comment on the plan)
                  </label>
                  <TextArea
                    value={revisionText}
                    onChange={(e) => setRevisionText(e.target.value)}
                    placeholder="What needs to change? Be specific — the agent will read this."
                    rows={4}
                    textAreaSize="compact"
                  />
                  <div className="flex gap-2">
                    <Button
                      data-testid="plan-revision-submit"
                      size="sm"
                      onClick={handleRequestChanges}
                      disabled={busy || !revisionText.trim()}
                    >
                      Submit revision request
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setRequestMode(false);
                        setRevisionText('');
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer actions */}
        {!loading && plan && (
          <div className="flex items-center justify-end gap-2 border-t border-edge px-5 py-3">
            <Button size="sm" variant="ghost" onClick={onClose}>
              Close
            </Button>
            {!requestMode && badgeState !== 'approved' && (
              <Button
                data-testid="plan-request-changes"
                size="sm"
                variant="ghost"
                onClick={() => setRequestMode(true)}
                disabled={busy}
              >
                Request Changes
              </Button>
            )}
            {badgeState !== 'approved' && (
              <Button
                data-testid="plan-approve"
                size="sm"
                onClick={handleApprove}
                disabled={busy}
              >
                Approve
              </Button>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
