import { useEffect, useMemo, useState } from 'react';
import type { DocWithGraph, Task, Comment, PlanReadinessEntry } from '../api/types';
import { fetchPlanReadiness } from '../api/client';
import { useChat } from './ChatContext';
import { CommentTray } from './CommentTray';
import { PromptModal } from './PromptModal';
import {
  ExecutionPlanModal,
  derivePlanBadgeState,
  planStateLabel,
  PLAN_STATE_CLASSES,
} from './ExecutionPlanModal';
import { Badge, Button } from './ui';
import { renderTaskInitPrompt } from '../utils/taskInitPrompt';

interface TaskPanelProps {
  /** Retained for call-site compatibility — was only consumed by the removed
   *  t-19 graph-view persistence (spec-164 dec-2). */
  docId?: string;
  /**
   * The full spec document. Optional so legacy callers that only have docId
   * still render — but the per-task "Spec Coding Agent" prompt needs the
   * spec's title, decisions, and sections to give the agent the
   * already-settled context. Without this prop, the Prompt button is hidden.
   */
  doc?: DocWithGraph;
  tasks: Task[];
  commentsByTask?: Record<string, Comment[]>;
  forceShowComments?: boolean;
  onCommentsChange?: (targetId: string, comments: Comment[]) => void;
  onUpdate: () => void;
  /**
   * spec-159 ac-18: tasks are read-only in the UI — created and driven only by
   * coding agents through the MCP tools. The panel renders no task-mutation
   * control. `canWrite` now gates a single remaining write: the comment
   * composer in each task's tray (users give feedback through comments). When
   * false (non-member reading a public Memex), the composer is suppressed too.
   * Task content (status, ACs, blockers, the "Prompt" affordance, the graph)
   * stays readable. Defaults to true so member call sites are unchanged.
   */
  canWrite?: boolean;
}

const statusLabel: Record<string, string> = {
  not_started: 'ready',
  in_progress: 'in progress',
  complete: 'complete',
};

export function TaskPanel({ docId: _docId, doc, tasks, commentsByTask = {}, forceShowComments, onCommentsChange, onUpdate, canWrite = true }: TaskPanelProps) {
  const chat = useChat();
  const [showCommentsFor, setShowCommentsFor] = useState<string | null>(null);
  const [promptText, setPromptText] = useState<string | null>(null);

  // Per-task plan readiness, keyed by task id. Populated lazily from
  // /api/execution-plans/readiness whenever the set of tasks-with-plans
  // changes. Tasks without an executionPlanDocId never appear here.
  const [readinessByTask, setReadinessByTask] = useState<Record<string, PlanReadinessEntry>>({});
  const [openPlanForTask, setOpenPlanForTask] = useState<Task | null>(null);

  const taskIdsWithPlans = useMemo(
    () => tasks.filter((t) => t.executionPlanDocId).map((t) => t.id),
    [tasks],
  );
  // Stringify the id list so the effect re-fires only when the *set* changes,
  // not on every parent re-render that produces a fresh array reference.
  const planTaskIdsKey = taskIdsWithPlans.join(',');

  useEffect(() => {
    if (taskIdsWithPlans.length === 0) {
      setReadinessByTask({});
      return;
    }
    let cancelled = false;
    fetchPlanReadiness(taskIdsWithPlans)
      .then((entries) => {
        if (cancelled) return;
        const next: Record<string, PlanReadinessEntry> = {};
        for (const e of entries) next[e.taskId] = e;
        setReadinessByTask(next);
      })
      .catch((err) => console.warn('Failed to fetch plan readiness:', err));
    return () => {
      cancelled = true;
    };
    // taskIdsWithPlans is the underlying value; planTaskIdsKey is the cheap
    // dependency the effect actually wants to react to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planTaskIdsKey]);

  // The per-task prompt is built from a static template — no LLM round-trip.
  // Mirrors the spec "Spec Coding Agent" approach (see InitPromptDialog
  // and specInitPrompt.ts): the value is the briefing, not bespoke prose.
  // The agent is told to call back into Memex via MCP for the live state, so
  // the prompt only needs to give it enough context to start (spec, task,
  // decisions, comments) plus the playbook.
  const handleOpenPrompt = (task: Task) => {
    if (!doc) return;
    setPromptText(renderTaskInitPrompt(doc, task, commentsByTask[task.id] ?? []));
  };

  const ready = tasks.filter((t) => !t.blocked && t.status === 'not_started');
  const blocked = tasks.filter((t) => t.blocked);
  const inProgress = tasks.filter((t) => t.status === 'in_progress');
  const complete = tasks.filter((t) => t.status === 'complete');

  const getDisplayStatus = (t: Task) => {
    if (t.blocked) return 'blocked';
    return t.status;
  };

  return (
    <div data-testid="task-panel" className="border rounded-lg p-5 border-edge bg-panel">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-heading uppercase tracking-wider">
          Tasks
        </h3>
        <span className="text-xs text-muted">
          {ready.length} ready, {blocked.length} blocked, {inProgress.length} in progress, {complete.length} complete
        </span>
      </div>

      {/* spec-164 dec-2: the t-19 graph view is removed — the build tab is
          list-only. A future task graph should arrive via its own spec. */}
      {tasks.length === 0 && (
        <p className="text-sm text-muted mb-4">No tasks yet. Ask the agent in chat to scope work for this Spec.</p>
      )}

      <div className="space-y-2 mb-4">
        {tasks.map((t) => {
          const display = getDisplayStatus(t);
          const openTaskComments = commentsByTask[t.id]?.filter((c) => !c.resolvedAt) ?? [];
          // spec-164 dec-6: only HUMAN-LOOP comments auto-open the tray.
          // Agent chatter (plan/progress) no longer pre-explodes the build
          // list — it stays behind the Comments button (whose count badge
          // still includes it, ac-25) and the tray's default-off chips.
          const taskOpenComments = openTaskComments.some(
            (c) => !['plan', 'progress'].includes(c.commentType ?? 'discussion'),
          );
          return (
            <div
              key={t.id}
              data-testid="task-card"
              data-task-seq={`T-${t.seq}`}
              data-task-status={display}
              onClick={() =>
                chat.addContextChip({
                  type: 'task',
                  id: t.id,
                  label: `Task T-${t.seq}`,
                })
              }
              className="group/task px-3 py-2.5 rounded-md border cursor-pointer transition-colors bg-surface/50 border-edge-subtle hover:bg-card-hover"
            >
              <div className="flex items-start gap-3">
                <span className="flex-none text-xs font-mono text-muted pt-0.5">
                  T-{t.seq}
                </span>
                <button
                  onClick={() =>
                    chat.addContextChip({
                      type: 'task',
                      id: t.id,
                      label: `Task T-${t.seq}`,
                    })
                  }
                  className="flex-none opacity-0 group-hover/task:opacity-100 transition-opacity p-0.5 rounded hover:bg-card-hover -ml-1"
                  title="Focus chat on this task"
                >
                  <svg className="w-3 h-3 text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
                  </svg>
                </button>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <Badge status={display} label={display === 'blocked' ? 'blocked' : statusLabel[t.status]} />
                    <span className="text-sm truncate text-primary">{t.title}</span>
                  </div>
                  <p className="text-xs text-muted mt-1 line-clamp-2">{t.description}</p>
                  {t.sectionRef && (
                    <Badge status="archived" label={t.sectionRef} className="mt-1" />
                  )}
                  {t.acceptanceCriteria && t.acceptanceCriteria.length > 0 && (
                    <div className="mt-1.5 space-y-0.5">
                      {t.acceptanceCriteria.map((ac, i) => (
                        <div key={i} className="flex items-center gap-1.5 text-[11px]">
                          <span className={ac.done ? 'text-status-success-text' : 'text-muted'}>{ac.done ? '[x]' : '[ ]'}</span>
                          <span className={ac.done ? 'text-muted line-through' : 'text-secondary'}>{ac.description}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {t.blocked && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {t.blockedByDecisions.map((d) => (
                        <Badge key={d.id} status="blocked" label={`D-${d.seq}`} />
                      ))}
                      {t.blockedByTasks.map((w) => (
                        <Badge key={w.id} status="blocked" label={`T-${w.seq}`} />
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex-none flex items-center gap-2">
                  {t.executionPlanDocId && (() => {
                    const entry = readinessByTask[t.id];
                    const state = derivePlanBadgeState(
                      entry?.planStatus ? { status: entry.planStatus } : null,
                      entry?.readinessContent ?? null,
                    );
                    return (
                      <button
                        data-testid="plan-trigger"
                        data-plan-state={state}
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenPlanForTask(t);
                        }}
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border transition-colors ${PLAN_STATE_CLASSES[state]}`}
                        title="Open execution plan"
                      >
                        Plan: {planStateLabel(state)}
                      </button>
                    );
                  })()}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowCommentsFor(forceShowComments || showCommentsFor === t.id ? null : t.id);
                    }}
                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs font-medium transition-colors border
                      ${forceShowComments || taskOpenComments || showCommentsFor === t.id
                        ? 'bg-overlay text-primary border-edge-strong'
                        : 'opacity-0 group-hover/task:opacity-100 bg-surface/50 text-muted border-edge hover:bg-overlay'
                      }`}
                    title={forceShowComments || showCommentsFor === t.id ? 'Hide comments' : 'Show comments'}
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
                    </svg>
                    {(commentsByTask[t.id]?.filter((c) => !c.resolvedAt).length ?? 0) > 0
                      ? commentsByTask[t.id]?.filter((c) => !c.resolvedAt).length
                      : '+'}
                  </button>
                  {doc && (
                    <Button
                      data-testid="task-prompt"
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleOpenPrompt(t);
                      }}
                      title="Hand this task to a coding agent"
                    >
                      Prompt
                    </Button>
                  )}
                </div>
              </div>

              {(forceShowComments || taskOpenComments || showCommentsFor === t.id) && (
                <div className={`mt-2 pt-2 border-t border-edge ${taskOpenComments ? 'border-l-2 border-l-accent pl-2 -ml-1' : ''}`} onClick={(e) => e.stopPropagation()}>
                  <CommentTray
                    targetType="task"
                    targetId={t.id}
                    comments={commentsByTask[t.id] ?? []}
                    onCommentsChange={onCommentsChange}
                    canWrite={canWrite}
                    muteAgentChatter
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {promptText !== null && (
        <PromptModal
          prompt={promptText}
          loading={false}
          title="Spec Coding Agent — Task"
          onClose={() => setPromptText(null)}
        />
      )}

      {openPlanForTask?.executionPlanDocId && (
        <ExecutionPlanModal
          task={openPlanForTask}
          planDocId={openPlanForTask.executionPlanDocId}
          onClose={() => setOpenPlanForTask(null)}
          onUpdate={() => {
            // Refetch readiness so the trigger badge reflects the new state
            // (Approve flips planStatus → 'approved'; the modal calls onUpdate
            // after the API call resolves). Also bubble up so the rest of the
            // spec view picks up any related changes.
            fetchPlanReadiness(taskIdsWithPlans)
              .then((entries) => {
                const next: Record<string, PlanReadinessEntry> = {};
                for (const e of entries) next[e.taskId] = e;
                setReadinessByTask(next);
              })
              .catch((err) => console.warn('Failed to refresh plan readiness:', err));
            onUpdate();
          }}
        />
      )}
    </div>
  );
}
