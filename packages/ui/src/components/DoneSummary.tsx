// DoneSummary — the report view shown when a Spec is done (spec-159 dec-1, t-4).
//
// Calm, conclusive, retrospective: the deliberate opposite of the active Verify
// view. A SINGLE column — no two-column layout, no sub-tabs. Where Verify feels
// in-motion (live AC states, failing items shouted out), this reads as a
// finished record: what was done, when it was done, and how long ago.
//
// It is NOT a stored artifact. The whole report is derived from data the page
// has already fetched — the doc, its decisions, tasks, ACs, and issues — passed
// in as props. The component makes NO network call of its own (ac-9): no fetch,
// no new endpoint, no new table. The same panels (DecisionPanel / TaskPanel /
// AcPanel / IssuePanel) are handed these exact shapes elsewhere on the page.
//
// spec-196 dec-4: beneath the report, a "Read the spec" toggle (ALL postures —
// reading is not a write) expands the full record inline: the sorted narrative
// sections plus read-only decision/task/AC/issue detail. It shares the footer's
// single action row with Reopen (which spec-196 relaxed from an editor-posture
// gate to an org-write gate — the reviewer/editor split means nothing here).
// Deliberately NOT the live panels — AcPanel and IssuePanel fetch their own
// data and TaskPanel fetches plan readiness, which would break this
// component's fetch-free posture (ac-9 / spec-196 ac-14). The detail renders
// from the props above; no mutation affordances; expanding never changes phase.
//
// Timeline degradation: the doc data carries only `createdAt` and the LATEST
// `statusChangedAt` (when it became `done`) — there is no per-phase change log
// on the doc today. So the timeline renders what's actually known (start → done
// + total elapsed) rather than fabricating intermediate specify/build/verify dates.

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { Decision, Task, Issue, DocWithGraph } from '../api/types';
import type { AcWithVerification, DocAssigneeView } from '../api/client';
import { Button, Card } from './ui';
import { phaseDisplayName } from '../utils/phaseDisplay';

interface DoneSummaryProps {
  /** The full Spec document — supplies title, completion timestamp, creator. */
  doc: DocWithGraph;
  /** Same shape DecisionPanel receives. */
  decisions: Decision[];
  /** Same shape TaskPanel receives. */
  tasks: Task[];
  /** Same shape AcPanel works with (fetchAcsForBrief result). */
  acs: AcWithVerification[];
  /** Same shape IssuePanel works with (fetchIssues result). */
  issues: Issue[];
  /**
   * The Spec's assignees (spec-118 shape). Optional and already-fetched by the
   * parent — DoneSummary never fetches them itself. When absent it degrades to
   * the doc's creator, so the People row always shows someone.
   */
  people?: DocAssigneeView[];
  /**
   * spec-164 dec-5 (relaxed by spec-196): when true the report carries the
   * "Reopen" affordance — the one deliberate door back to `verify`. The parent
   * now gates this on org WRITE ACCESS, not an editor posture: the
   * reviewer/editor distinction carries no meaning on a closed spec, so any
   * member who could write may reopen. Still hidden for read-only (non-member)
   * viewers, whose reopen would 403. Defaults to false.
   */
  canReopen?: boolean;
  /**
   * Confirmed-reopen callback. The PARENT performs the status write (and the
   * refetch) — DoneSummary itself still makes no network call (ac-9).
   */
  onReopen?: () => void | Promise<void>;
}

// One date, spelled the way the sketch shows it ("12 June 2026").
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

// "3 days ago" — the human-scale relative the headline trails the date with.
// Day granularity matches the retrospective tone (a done Spec is rarely
// interesting at second/minute resolution).
function relativeDays(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

// Whole-day span between two timestamps, for the "(N days total)" tail.
function daysBetween(startIso: string, endIso: string): number {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  return Math.max(0, Math.round(ms / 86_400_000));
}

function personLabel(p: { name: string | null; email: string | null }): string {
  return p.name?.trim() || p.email?.trim() || 'Unknown';
}

// A single label + value line in the report body. Keeps the column alignment
// (fixed-width label, value flows) consistent across every count row.
function ReportRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4 text-sm">
      <span className="w-28 shrink-0 font-medium text-muted">{label}</span>
      <span className="text-primary">{children}</span>
    </div>
  );
}

export function DoneSummary({
  doc,
  decisions,
  tasks,
  acs,
  issues,
  people,
  canReopen = false,
  onReopen,
}: DoneSummaryProps) {
  // spec-164 dec-5: two-step confirm, inline (mirrors the transition
  // sentence's no-modal posture). 'idle' → button; 'confirming' → question +
  // Yes/Cancel; 'submitting' while the parent's status write is in flight.
  const [reopenState, setReopenState] = useState<'idle' | 'confirming' | 'submitting'>('idle');

  // spec-196 dec-4: "Read the spec" — collapsed by default so the calm
  // retrospective stays the landing state; expanding is pure presentation
  // (no fetch, no phase change).
  const [readOpen, setReadOpen] = useState(false);

  const handleReopenYes = async () => {
    setReopenState('submitting');
    try {
      await onReopen?.();
    } finally {
      // If the write succeeded the parent re-renders away from `done` and
      // this component unmounts; on failure we fall back to the button.
      setReopenState('idle');
    }
  };

  // ── Decisions: resolved of total. There's no "reopened" signal on the
  //    Decision row, so reopened renders as 0 (honest absence, not a guess).
  const decisionsResolved = decisions.filter((d) => d.status === 'resolved').length;

  // ── Tasks: completed vs the residual. A task that left the board without
  //    completing was kicked to an issue (build phase) — we don't carry a
  //    discrete "kicked" flag on Task, so the residual (non-complete) stands
  //    in for it. Degrades gracefully: both numbers always sum to the total.
  const tasksCompleted = tasks.filter((t) => t.status === 'complete').length;
  const tasksKicked = tasks.length - tasksCompleted;

  // ── Acceptance: verified of total active ACs.
  const acsTotal = acs.length;
  const acsVerified = acs.filter((a) => a.verificationState === 'verified').length;

  // ── Issues: raised (all) vs resolved-or-converted (wound down).
  const issuesRaised = issues.length;
  const issuesResolved = issues.filter(
    (i) => i.status === 'resolved' || i.status === 'converted',
  ).length;

  // ── People: assignees if the parent passed them, else the creator. Either
  //    way this is already-fetched data — DoneSummary fetches nothing.
  const peopleLabels: string[] =
    people && people.length > 0
      ? people.map(personLabel)
      : doc.creator
        ? [personLabel(doc.creator)]
        : [];

  const completedAt = doc.statusChangedAt;
  const totalDays = daysBetween(doc.createdAt, completedAt);

  // spec-196 dec-4: the full record, from data already in hand.
  const sortedSections = [...(doc.sections ?? [])].sort((a, b) => a.seq - b.seq);
  const recordHeading = 'text-sm font-semibold text-muted tracking-wide mb-3';

  return (
    <Card variant="panel" data-testid="done-summary" className="max-w-3xl mx-auto">
      {/* Headline — the conclusion. ✓ + completion date + how long ago. */}
      <div className="text-center py-4">
        <p className="text-lg text-status-success-text">
          <span aria-hidden="true">✓ </span>
          This spec was completed on {formatDate(completedAt)} ({relativeDays(completedAt)})
        </p>
      </div>

      <hr className="border-edge-subtle my-2" />

      <h3 className="text-sm font-semibold text-muted tracking-wide mt-4 mb-3">Summary</h3>

      <div className="space-y-3">
        {/* Timeline — start → done with the total span. Intermediate phase
            dates aren't on the doc today, so we render what's known. */}
        <ReportRow label="Timeline">
          {formatDate(doc.createdAt)} (created) → {formatDate(completedAt)} (done)
          {'  '}
          <span className="text-muted">({totalDays} day{totalDays === 1 ? '' : 's'} total)</span>
        </ReportRow>

        <ReportRow label="Decisions">
          {decisionsResolved} resolved · 0 reopened
        </ReportRow>

        <ReportRow label="Tasks">
          {tasksCompleted} completed · {tasksKicked} kicked to issue
        </ReportRow>

        <ReportRow label="Acceptance">
          {acsTotal} AC{acsTotal === 1 ? '' : 's'} · {acsVerified} verified
        </ReportRow>

        <ReportRow label="Issues">
          {issuesRaised} raised · {issuesResolved} resolved
        </ReportRow>

        <ReportRow label="People">
          {peopleLabels.length > 0 ? peopleLabels.join(' · ') : 'Unknown'}
        </ReportRow>
      </div>

      {/* The done view's action footer — one divider, one centred row.
          • "Read the spec" (spec-196 dec-4) is offered to everyone — reading is
            not a write.
          • "Reopen" (spec-164 dec-5, relaxed by spec-196) needs org write
            access (canReopen) but NOT an editor posture — the reviewer/editor
            distinction is meaningless on a closed spec. An explicit two-step
            confirm; the parent performs the verify status write. */}
      <div className="mt-6 pt-4 border-t border-edge-subtle">
        <div className="flex flex-wrap items-center justify-center gap-3 text-sm text-secondary">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-testid="done-read-spec"
            aria-expanded={readOpen}
            onClick={() => setReadOpen((v) => !v)}
          >
            {readOpen ? 'Hide the spec' : 'Read the spec'}
          </Button>

          {canReopen &&
            (reopenState === 'idle' ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                data-testid="done-reopen"
                onClick={() => setReopenState('confirming')}
              >
                Reopen
              </Button>
            ) : (
              <span
                data-testid="done-reopen-confirm"
                className="inline-flex flex-wrap items-center gap-2"
              >
                Move this spec back to {phaseDisplayName('verify')}?
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  data-testid="done-reopen-yes"
                  disabled={reopenState === 'submitting'}
                  onClick={() => void handleReopenYes()}
                >
                  {reopenState === 'submitting' ? 'Reopening…' : 'Yes'}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={reopenState === 'submitting'}
                  onClick={() => setReopenState('idle')}
                >
                  Cancel
                </Button>
              </span>
            ))}
        </div>

        {readOpen && (
          <div data-testid="done-read-spec-body" className="mt-6 space-y-8 text-left">
            {/* The narrative — sorted sections, same prose treatment as the
                live page, minus comments/editing. */}
            <div className="space-y-6">
              {sortedSections.map((section, index) => (
                <div key={section.id} data-testid="done-read-section">
                  <h4 className="text-base font-semibold text-primary mb-2">
                    {index + 1}. {section.title || section.sectionType}
                  </h4>
                  <div className="prose-dark overflow-hidden">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                      {section.content}
                    </ReactMarkdown>
                  </div>
                </div>
              ))}
            </div>

            {decisions.length > 0 && (
              <div>
                <h3 className={recordHeading}>Decisions</h3>
                <ul className="space-y-3">
                  {decisions.map((d) => (
                    <li key={d.id} className="text-sm" data-testid="done-read-decision">
                      <span className="font-medium text-primary">{d.title}</span>{' '}
                      <span className="text-muted">({d.status})</span>
                      {d.resolution && (
                        <div className="text-secondary mt-1 whitespace-pre-wrap">{d.resolution}</div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {tasks.length > 0 && (
              <div>
                <h3 className={recordHeading}>Tasks</h3>
                <ul className="space-y-1.5">
                  {tasks.map((t) => (
                    <li key={t.id} className="text-sm text-primary" data-testid="done-read-task">
                      {t.title} <span className="text-muted">({t.status.replace('_', ' ')})</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {acs.length > 0 && (
              <div>
                <h3 className={recordHeading}>Acceptance Criteria</h3>
                <ul className="space-y-1.5">
                  {acs.map((a) => (
                    <li key={a.ac.id} className="text-sm text-primary" data-testid="done-read-ac">
                      {a.ac.statement}{' '}
                      <span className="text-muted">
                        ({a.ac.kind}
                        {a.verificationState === 'verified' ? ' · verified' : ''})
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {issues.length > 0 && (
              <div>
                <h3 className={recordHeading}>Issues</h3>
                <ul className="space-y-1.5">
                  {issues.map((i) => (
                    <li key={i.id} className="text-sm text-primary" data-testid="done-read-issue">
                      {i.title} <span className="text-muted">({i.status})</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
