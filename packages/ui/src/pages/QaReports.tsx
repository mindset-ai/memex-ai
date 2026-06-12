// QA Reports — the workspace-wide feed of build-session QA reports (spec-260
// dec-5/dec-6). A Pulse-style top-level nav page: every `qa_report` section
// across the memex's Specs, newest-first, an initial page + keyset "Load More",
// live updates off the std-8 bus. Each row shows WHEN it was generated, WHICH
// Spec it belongs to (linked), and WHO executed the build session (the std-32
// actor on the row). Opening the page records the per-user view marker, zeroing
// the nav badge (count-everything semantics — own-agent reports included).

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { PageHeader } from '../components/PageHeader';
import {
  recordQaReportsView,
  useQaReportsFeed,
  type QaReportFeedRow,
} from '../hooks/useQaReports';
import { useDocChangeStream } from '../hooks/useDocChangeStream';
import { tenantPath } from '../utils/tenantUrl';
import { formatDate } from '../utils/format';

const ACTOR_KIND_LABEL: Record<QaReportFeedRow['actorKind'], string> = {
  human: '',
  mcp_agent: 'agent',
  in_app_agent: 'agent',
  system: 'system',
};

function executorLabel(row: QaReportFeedRow): string {
  const name = row.actorName?.trim();
  const kind = ACTOR_KIND_LABEL[row.actorKind];
  if (name && kind) return `${name} (${kind})`;
  if (name) return name;
  return kind || 'unknown';
}

function FeedRow({ row, defaultOpen = false }: { row: QaReportFeedRow; defaultOpen?: boolean }) {
  // ac-24: unread rows arrive expanded; read rows collapsed. Initial state
  // only — the user's own toggling always wins afterwards.
  const [open, setOpen] = useState(defaultOpen);
  return (
    <li
      data-testid="qa-report-row"
      className="rounded-xl border border-edge bg-surface p-4"
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
        <Link
          data-testid="qa-report-row-spec"
          to={tenantPath(`/specs/${row.docHandle}`)}
          className="font-medium text-primary hover:underline"
        >
          {row.docHandle} · {row.docTitle}
        </Link>
        {row.version > 1 && (
          <span className="text-xs text-muted">session {row.version}</span>
        )}
        <span className="ml-auto text-xs text-muted">
          <span data-testid="qa-report-row-when">{formatDate(row.createdAt)}</span>
          {' · '}
          <span data-testid="qa-report-row-who">{executorLabel(row)}</span>
        </span>
      </div>
      <button
        type="button"
        data-testid="qa-report-row-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="mt-2 text-xs text-secondary hover:text-primary"
      >
        {open ? 'Hide report' : 'Read report'}
      </button>
      {open && (
        <div data-testid="qa-report-row-body" className="mt-3 prose-dark overflow-hidden">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{row.content}</ReactMarkdown>
        </div>
      )}
    </li>
  );
}

export function QaReports() {
  const { rows, loading, error, hasMore, loadOlder, refresh } = useQaReportsFeed();

  // ac-24: the unread boundary — the viewer's PREVIOUS last_viewed_at, captured
  // from the view receipt (opening the page is what resets the marker, so the
  // receipt is the only place the old value survives).
  //   undefined        → receipt still in flight (hold the list so rows don't
  //                      initialise collapsed and then refuse to open)
  //   { prev: null }   → first-ever view: everything is unread → all open
  //   { prev: ISO }    → rows newer than it are unread → open
  //   { prev: 'all' }  → marker unavailable (anonymous / failure): no per-user
  //                      unread concept → all collapsed
  const [boundary, setBoundary] = useState<{ prev: string | null | 'all' } | undefined>(undefined);

  // Opening the page = viewing the feed: upsert the per-user marker (dec-6),
  // which zeroes the nav badge, and keep its receipt as the unread boundary.
  useEffect(() => {
    let cancelled = false;
    void recordQaReportsView().then((receipt) => {
      if (cancelled) return;
      setBoundary(receipt ? { prev: receipt.previousLastViewedAt } : { prev: 'all' });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Both ISO-8601 UTC strings from the same serializer, so lexicographic
  // comparison is chronological.
  const isUnread = (row: QaReportFeedRow): boolean => {
    if (!boundary || boundary.prev === 'all') return false;
    if (boundary.prev === null) return true;
    return row.createdAt > boundary.prev;
  };

  // Live updates: a new report lands on the std-8 bus as a section event —
  // refetch the first page so it appears without a reload (debounced upstream).
  useDocChangeStream(null, refresh);

  return (
    <div className="px-6 py-4 max-w-3xl">
      <PageHeader title="QA Reports" />
      <p className="text-sm text-muted mb-4">
        What each build session changed, written for a reviewer — one report per
        session, newest first.
      </p>

      {error && (
        <div data-testid="qa-reports-error" className="text-sm text-status-danger-text mb-4">
          {error}
        </div>
      )}

      {(loading && rows.length === 0) || boundary === undefined ? (
        <div data-testid="qa-reports-loading" className="text-sm text-muted py-8 text-center">
          Loading…
        </div>
      ) : rows.length === 0 ? (
        <div data-testid="qa-reports-empty" className="text-sm text-muted py-8 text-center">
          No QA reports yet — one is generated each time a build session hands off to
          verify.
        </div>
      ) : (
        <ul data-testid="qa-reports-list" className="space-y-3">
          {rows.map((row) => (
            <FeedRow key={row.id} row={row} defaultOpen={isUnread(row)} />
          ))}
        </ul>
      )}

      {hasMore && (
        <div className="mt-4 text-center">
          <button
            type="button"
            data-testid="qa-reports-load-more"
            onClick={() => void loadOlder()}
            className="text-sm text-secondary hover:text-primary px-3 py-1.5 rounded-md border border-edge hover:bg-overlay"
          >
            Load More
          </button>
        </div>
      )}
    </div>
  );
}
