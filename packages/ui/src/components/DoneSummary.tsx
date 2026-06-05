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
// Timeline degradation: the doc data carries only `createdAt` and the LATEST
// `statusChangedAt` (when it became `done`) — there is no per-phase change log
// on the doc today. So the timeline renders what's actually known (start → done
// + total elapsed) rather than fabricating intermediate plan/build/verify dates.

import type { Decision, Task, Issue, DocWithGraph } from '../api/types';
import type { AcWithVerification, DocAssigneeView } from '../api/client';
import { Card } from './ui';

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

export function DoneSummary({ doc, decisions, tasks, acs, issues, people }: DoneSummaryProps) {
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
    </Card>
  );
}
