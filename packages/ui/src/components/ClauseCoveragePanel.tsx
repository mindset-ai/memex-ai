// spec-151 t-7 (ac-2, ac-13) — the Standard's clause-coverage view. Mirrors the
// AC matrix: which clauses carry a test and whether the latest emission is green,
// with CI-backed green surfaced DISTINCTLY from local-only passing (dec-4). The
// denominator is testable obligations only (ac-16), computed server-side.

import { useEffect, useState } from 'react';
import {
  fetchClauseCoverage,
  type StandardClauseCoverage,
  type ClauseCoverageState,
  type ClauseWithVerification,
} from '../api/clause-coverage';

// Distinct visual + textual treatment per state. `verified` (CI-backed) and
// `local` (passing-but-not-CI) are deliberately different colours AND labels so a
// green badge never silently reads as enforced-at-merge (ac-13).
const STATE_META: Record<
  ClauseCoverageState,
  { label: string; className: string }
> = {
  verified: { label: 'CI-verified', className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' },
  local: { label: 'local-only', className: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' },
  failing: { label: 'failing', className: 'bg-rose-500/15 text-rose-700 dark:text-rose-300' },
  stale: { label: 'stale', className: 'bg-zinc-400/15 text-zinc-600 dark:text-zinc-300' },
  untested: { label: 'untested', className: 'bg-zinc-300/20 text-zinc-500 dark:text-zinc-400' },
};

function ClauseRow({ row }: { row: ClauseWithVerification }): JSX.Element {
  const meta = STATE_META[row.state];
  return (
    <li
      data-testid={`clause-row-cl-${row.clause.seq}`}
      data-state={row.state}
      data-countable={row.countable ? 'true' : 'false'}
      className="flex items-start gap-3 py-2 border-b border-black/5 dark:border-white/5"
    >
      <span className="font-mono text-xs text-zinc-500 shrink-0 w-12">cl-{row.clause.seq}</span>
      <span className="flex-1 text-sm text-zinc-700 dark:text-zinc-200 line-clamp-2">
        {row.clause.body}
      </span>
      {row.clause.testable && row.clause.archetype ? (
        <span className="font-mono text-[10px] text-zinc-400 shrink-0">{row.clause.archetype}</span>
      ) : null}
      <span
        data-testid={`clause-badge-cl-${row.clause.seq}`}
        className={`shrink-0 rounded px-2 py-0.5 text-[11px] font-medium ${meta.className}`}
      >
        {meta.label}
      </span>
    </li>
  );
}

/**
 * Pure presentational view — rendered from already-fetched coverage. Exported so a
 * component test can drive every state branch without a network round-trip.
 */
export function ClauseCoverageView({
  coverage,
}: {
  coverage: StandardClauseCoverage;
}): JSX.Element {
  const { clauses, countableTotal, coveredCount, verifiedCount } = coverage;
  // Only testable obligations count toward coverage (ac-16); other clauses are
  // shown but visually de-emphasised and excluded from the headline ratio.
  return (
    <section data-testid="clause-coverage" className="mt-6">
      <header className="flex items-baseline justify-between mb-2">
        <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">Clause coverage</h3>
        <span data-testid="clause-coverage-summary" className="text-xs text-zinc-500">
          {verifiedCount}/{countableTotal} testable obligations CI-verified
          {' · '}
          {coveredCount}/{countableTotal} covered
        </span>
      </header>
      {countableTotal === 0 ? (
        <p className="text-xs text-zinc-400">No testable obligations on this standard yet.</p>
      ) : (
        <ul className="list-none m-0 p-0">
          {clauses.map((row) => (
            <ClauseRow key={row.clause.id} row={row} />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Container — fetches the coverage for a standard's docId and renders the view.
 * Attached to the standard's document page.
 */
export function ClauseCoveragePanel({ docId }: { docId: string }): JSX.Element | null {
  const [coverage, setCoverage] = useState<StandardClauseCoverage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchClauseCoverage(docId)
      .then((c) => {
        if (!cancelled) setCoverage(c);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load clause coverage');
      });
    return () => {
      cancelled = true;
    };
  }, [docId]);

  if (error) return null; // coverage is an enhancement; never block the doc on it
  if (!coverage) return null;
  return <ClauseCoverageView coverage={coverage} />;
}
