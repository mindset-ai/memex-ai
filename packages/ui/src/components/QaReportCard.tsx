// spec-260 (dec-1): the read-only QA Report card — the per-Spec render seat for
// `qa_report` sections. One component, three seats:
//
//   • Verify — front-loaded full-width card ABOVE the ACs │ Issues columns,
//     expanded by default (the cold verifier reads it first), collapsible so it
//     folds away once read.
//   • Build — the body of the "QA Report" sub-tab, with a quiet empty state
//     until the first build→verify hand-off writes one.
//   • Done — the body behind the gated "QA report" button on DoneSummary.
//
// READ-ONLY everywhere (ac-11): no inline-edit affordance, no comment gutter —
// the report is a build *output*, not plan prose. Versioning display (dec-2):
// the latest build session's report shows by default; prior sessions stay
// reachable through the version switcher.

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { isQaReportSectionType, qaReportVersion } from '@memex/shared';
import type { DocSection } from '../api/types';
import { formatDate } from '../utils/format';

/**
 * The qa_report* rows of a Spec's sections, newest session first. Shared by
 * every seat so "latest" means the same thing everywhere.
 */
export function selectQaReports(sections: DocSection[]): DocSection[] {
  return sections
    .filter((s) => isQaReportSectionType(s.sectionType))
    .sort(
      (a, b) => (qaReportVersion(b.sectionType) ?? 0) - (qaReportVersion(a.sectionType) ?? 0),
    );
}

interface QaReportCardProps {
  /** qa_report sections, newest-first (selectQaReports output). */
  reports: DocSection[];
  /** Collapsed on first render? Verify wants false (front-loaded), Build true-ish n/a. */
  defaultCollapsed?: boolean;
  /** Shown when no report exists yet. Omit to render nothing when empty. */
  emptyState?: string;
  /** Whether the card chrome (border/heading) renders. The Done seat supplies its own. */
  bare?: boolean;
}

export function QaReportCard({ reports, defaultCollapsed = false, emptyState, bare = false }: QaReportCardProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  // Index into `reports` (0 = latest session). Reset is unnecessary — the list
  // only ever grows by prepending a newer session.
  const [versionIdx, setVersionIdx] = useState(0);

  if (reports.length === 0) {
    if (!emptyState) return null;
    return (
      <div data-testid="qa-report-empty" className="text-sm text-muted py-6 text-center">
        {emptyState}
      </div>
    );
  }

  const current = reports[Math.min(versionIdx, reports.length - 1)];
  const version = qaReportVersion(current.sectionType) ?? 1;

  const body = (
    <>
      {reports.length > 1 && (
        <div className="flex items-center gap-2 mb-3 text-xs text-muted">
          <span>Build session:</span>
          <select
            data-testid="qa-report-version-switcher"
            className="bg-transparent border border-edge rounded-md px-1.5 py-0.5 text-xs text-secondary"
            value={versionIdx}
            onChange={(e) => setVersionIdx(Number(e.target.value))}
          >
            {reports.map((r, i) => (
              <option key={r.id} value={i}>
                Session {qaReportVersion(r.sectionType) ?? 1} · {formatDate(r.createdAt)}
                {i === 0 ? ' (latest)' : ''}
              </option>
            ))}
          </select>
        </div>
      )}
      {/* Read-only prose — deliberately NO edit affordance (ac-11). */}
      <div data-testid="qa-report-content" className="prose-dark overflow-hidden">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{current.content}</ReactMarkdown>
      </div>
    </>
  );

  if (bare) {
    return <div data-testid="qa-report-card">{body}</div>;
  }

  return (
    <div
      data-testid="qa-report-card"
      className="mb-6 rounded-xl border border-edge bg-surface p-4"
    >
      <button
        type="button"
        data-testid="qa-report-toggle"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center justify-between text-left"
      >
        <span className="text-sm font-semibold text-heading">
          QA Report
          <span className="ml-2 font-normal text-muted">
            Session {version} · {formatDate(current.createdAt)}
          </span>
        </span>
        <span className="text-xs text-muted">{collapsed ? 'Show' : 'Hide'}</span>
      </button>
      {!collapsed && <div className="mt-3">{body}</div>}
    </div>
  );
}
