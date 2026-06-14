// QA Reports — the workspace-wide feed of build-session QA reports (spec-260
// dec-5/dec-6, redesigned in spec-286). A Pulse-style top-level nav page: every
// `qa_report` section across the memex's Specs, newest-first, an initial page +
// keyset "Load More", live updates off the std-8 bus.
//
// spec-286 reshapes each row into a CARD whose dominant heading is the spec
// (accent-coloured link), with a metadata line (author, implementer-if-different,
// relative time, phase pill) above a subordinate-scale markdown body — and adds a
// STICKY left rail to filter by tag and date range (server-parameterised, so the
// counts + filtering are correct across the whole corpus, not just loaded rows).
// Opening the page still records the per-user view marker (zeroing the nav badge).

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { PageHeader } from '../components/PageHeader';
import {
  recordQaReportsView,
  useQaReportsFeed,
  useQaReportTagFacets,
  type QaReportFeedRow,
} from '../hooks/useQaReports';
import { useDocChangeStream } from '../hooks/useDocChangeStream';
import {
  QaReportsFilterRail,
  ALL_TIME,
  type DateRangeState,
} from '../components/QaReportsFilterRail';
import { phaseColors } from '../components/phaseColors';
import { phaseDisplayName } from '../utils/phaseDisplay';
import { tenantPath } from '../utils/tenantUrl';
import { timeAgo } from '../utils/timeAgo';
import type { SpecStatus } from '../api/types';

const ACTOR_KIND_LABEL: Record<QaReportFeedRow['actorKind'], string> = {
  human: '',
  mcp_agent: 'agent',
  in_app_agent: 'agent',
  system: 'system',
};

function implementerLabel(row: QaReportFeedRow): string {
  const name = row.actorName?.trim();
  const kind = ACTOR_KIND_LABEL[row.actorKind];
  if (name && kind) return `${name} (${kind})`;
  if (name) return name;
  return kind || 'unknown';
}

function PhasePill({ phase }: { phase: string }) {
  const colors = phaseColors(phase as SpecStatus);
  return (
    <span
      data-testid="qa-report-phase-pill"
      data-phase={phase}
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none ${
        colors?.pill ?? 'border-edge-subtle text-secondary'
      }`}
    >
      {phaseDisplayName(phase)}
    </span>
  );
}

function FeedRow({
  row,
  defaultOpen = false,
  bulk,
}: {
  row: QaReportFeedRow;
  defaultOpen?: boolean;
  // ac-12: a bumped nonce drives a bulk expand/collapse from the page-level
  // control; per-row toggling still wins afterwards until the next bulk action.
  bulk: { open: boolean; nonce: number };
}) {
  // ac-24: unread rows arrive expanded; read rows collapsed. Initial state only —
  // the user's own toggling always wins afterwards.
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    // nonce 0 = no bulk action yet → leave the unread-driven initial state alone.
    if (bulk.nonce > 0) setOpen(bulk.open);
  }, [bulk.nonce, bulk.open]);

  const author = row.authorName?.trim() || null;
  const implementerName = row.actorName?.trim() || null;
  // ac-7: show the implementer only when it differs from the author. When the
  // author ran their own build (same name) we show a single attribution.
  const showImplementer = implementerName !== null && implementerName !== author;

  return (
    <li
      data-testid="qa-report-row"
      className="rounded-xl border border-edge bg-surface p-4"
    >
      {/* Heading: the spec is the card's identity — accent-coloured link, sized
          ABOVE the report body's headings (.prose-qa demotes those). */}
      <h3 className="text-lg font-semibold leading-snug">
        <Link
          data-testid="qa-report-row-spec"
          to={tenantPath(`/specs/${row.docHandle}`)}
          className="text-accent hover:text-accent-hover hover:underline"
        >
          <span className="text-accent/70">{row.docHandle}</span> {row.docTitle}
        </Link>
      </h3>

      {/* Metadata line — subordinate to the heading. */}
      <div
        data-testid="qa-report-row-meta"
        className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted"
      >
        <PhasePill phase={row.phase} />
        {author && (
          <span data-testid="qa-report-row-author">
            by <span className="text-secondary">{author}</span>
          </span>
        )}
        {showImplementer && (
          <span data-testid="qa-report-row-implementer">
            · built by <span className="text-secondary">{implementerLabel(row)}</span>
          </span>
        )}
        {row.version > 1 && <span>· session {row.version}</span>}
        <span data-testid="qa-report-row-when">· {timeAgo(row.createdAt)}</span>
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
        <div
          data-testid="qa-report-row-body"
          className="mt-3 prose-dark prose-qa overflow-hidden"
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{row.content}</ReactMarkdown>
        </div>
      )}
    </li>
  );
}

export function QaReports() {
  // ── Filter state (spec-286) ────────────────────────────────────────────────
  // tagId = null → "All". range carries concrete ISO bounds, computed once at
  // selection time (NOT per render) so the values are stable and don't churn the
  // feed/facets fetches. A tag + a date range compose with AND (dec-3).
  const [selectedTagId, setSelectedTagId] = useState<string | null>(null);
  const [range, setRange] = useState<DateRangeState>(ALL_TIME);

  // ac-12: bulk expand/collapse. The nonce bumps on every click so each row's
  // effect re-applies `open`; per-row toggling still wins until the next click.
  const [bulk, setBulk] = useState<{ open: boolean; nonce: number }>({ open: false, nonce: 0 });
  const toggleAll = () => setBulk((b) => ({ open: !b.open, nonce: b.nonce + 1 }));

  const filters = useMemo(
    () => ({ tagId: selectedTagId ?? undefined, from: range.from, to: range.to }),
    [selectedTagId, range.from, range.to],
  );
  const facetWindow = useMemo(() => ({ from: range.from, to: range.to }), [range.from, range.to]);

  const { rows, loading, error, hasMore, loadOlder, refresh } = useQaReportsFeed(filters);
  const { facets, loading: facetsLoading } = useQaReportTagFacets(facetWindow);

  // ac-24: the unread boundary — the viewer's PREVIOUS last_viewed_at, captured
  // from the view receipt (opening the page resets the marker, so the receipt is
  // the only place the old value survives). See the hook for the sentinel meanings.
  const [boundary, setBoundary] = useState<{ prev: string | null | 'all' } | undefined>(undefined);

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

  // Live updates: a new report lands on the std-8 bus as a section event — refetch
  // the first page so it appears without a reload (debounced upstream).
  useDocChangeStream(null, refresh);

  return (
    <div className="px-6 py-4">
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

      <div className="flex items-start gap-6">
        <QaReportsFilterRail
          facets={facets}
          loading={facetsLoading}
          selectedTagId={selectedTagId}
          onSelectTag={setSelectedTagId}
          range={range}
          onChangeRange={setRange}
        />

        <div className="min-w-0 flex-1 max-w-3xl">
          {(loading && rows.length === 0) || boundary === undefined ? (
            <div data-testid="qa-reports-loading" className="text-sm text-muted py-8 text-center">
              Loading…
            </div>
          ) : rows.length === 0 ? (
            <div data-testid="qa-reports-empty" className="text-sm text-muted py-8 text-center">
              {selectedTagId !== null || range.preset !== 'all'
                ? 'No QA reports match the current filter.'
                : 'No QA reports yet — one is generated each time a build session hands off to verify.'}
            </div>
          ) : (
            <>
              <div className="mb-2 flex justify-end">
                <button
                  type="button"
                  data-testid="qa-reports-expand-all"
                  aria-pressed={bulk.open}
                  onClick={toggleAll}
                  className="text-xs text-secondary hover:text-primary"
                >
                  {bulk.open ? 'Collapse all' : 'Expand all'}
                </button>
              </div>
              <ul data-testid="qa-reports-list" className="space-y-3">
                {rows.map((row) => (
                  <FeedRow key={row.id} row={row} defaultOpen={isUnread(row)} bulk={bulk} />
                ))}
              </ul>
            </>
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
      </div>
    </div>
  );
}
