// AcPanel — the fifth tab on a Spec view.
//
// Renders all acceptance criteria together. The `scope` vs `implementation`
// distinction lives on each card as a small badge — useful at authoring time,
// but most viewers pattern-match on STATUS, not KIND. Splitting the page into
// two sections (each with its own bars + sparkline) added explanation tax for
// every new viewer and visual noise without a corresponding scan win. The
// unified view leads with a single health band and a failing-first list; the
// kind badge is a soft affordance we can drop later if it stops earning the
// pixels.
//
// Two design principles still steer this layout:
//
//   1. Green is the headline. The aggregate band leads with what's working;
//      the failing-first sort puts the few rows that need attention at the top
//      so the calm green sea below is the dominant emotional mass.
//
//   2. The framing line at the top teaches the new mental model. Tests as
//      ongoing alignment-with-intent is not a paradigm the audience has met
//      before — they've seen unit tests, but tests have always certified
//      "code does what the author thought it should". The chain
//      INTENT → CODE → TEST is novel. A one-line framing header anchors it
//      without dragging the page into tutorial territory.
//
// Real-time: polls /acs/doc/:docId every 3s while the tab is visible (via
// the Page Visibility API). The polling stops when the tab is hidden so we
// don't burn cycles on inactive sessions. SSE-over-bus is the eventual
// upgrade path; see services/acs.ts comments and the hypothesis doc.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchAcsForBrief,
  fetchAcAlignmentHistory,
  type AcWithVerification,
  type AcAlignmentDay,
  type AcVerificationState,
} from '../api/client';
import { useChat } from './ChatContext';
import { AcSparkline } from './AcSparkline';
import { AcAboutDialog } from './AcAboutDialog';
import { AcMatrixCollapsible } from './AcMatrixCollapsible';

interface AcPanelProps {
  docId: string;
  /** Set by parent (DocDocument) when arriving at this tab via a click on a
   *  DecisionAcStrip pill. AcPanel scrolls the matching row into view and
   *  flashes a highlight ring, then calls onFocusConsumed so a tab re-visit
   *  doesn't re-trigger the highlight. */
  focusedAcId?: string | null;
  onFocusConsumed?: () => void;
}

const POLL_INTERVAL_MS = 3_000;

// Palette deliberately kept warm, not strident. Failing uses rose-500
// (softer than red-500 — recognisably "broken" without the glare of
// danger-red). Untested + stale stay quiet but distinct from each other.
const STATE_COLOURS: Record<AcVerificationState, string> = {
  verified: 'bg-green-500',
  failing: 'bg-rose-500',
  untested: 'bg-zinc-300',
  stale: 'bg-amber-400',
};

const STATE_LABEL: Record<AcVerificationState, string> = {
  verified: 'verified',
  failing: 'failing',
  untested: 'untested',
  stale: 'stale',
};

// Failing first, then degrees of needs-attention, then the calm verified mass.
// Within each bucket the original seq order is preserved so rows don't shuffle
// on every poll tick.
const STATE_ORDER: Record<AcVerificationState, number> = {
  failing: 0,
  stale: 1,
  untested: 2,
  verified: 3,
};

function lastVerifiedAt(rows: AcWithVerification[]): Date | null {
  let latest: Date | null = null;
  for (const r of rows) {
    if (r.verificationState !== 'verified') continue;
    for (const t of r.tests) {
      if (t.latestStatus !== 'pass') continue;
      const at = new Date(t.latestRunAt);
      if (latest === null || at > latest) latest = at;
    }
  }
  return latest;
}

function relativeTime(d: Date | null): string {
  if (!d) return 'never';
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

// The alignment-history endpoint returns one row per (date, kind). The
// unified header sums verified + total across kinds so the sparkline reflects
// one health curve, not two stacked ones.
function mergeAlignmentHistory(history: AcAlignmentDay[]): AcAlignmentDay[] {
  const byDate = new Map<string, { verified: number; total: number }>();
  for (const h of history) {
    const entry = byDate.get(h.date) ?? { verified: 0, total: 0 };
    entry.verified += h.verified;
    entry.total += h.total;
    byDate.set(h.date, entry);
  }
  return Array.from(byDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, { verified, total }]) => ({
      // `kind` is unused by the sparkline (it only reads date/verified/total)
      // but the type requires the field, so we tag the merged rows as 'scope'
      // arbitrarily. Don't read this value downstream.
      date,
      kind: 'scope' as const,
      verified,
      total,
    }));
}

// ─────────────────────────────────────────────────────────────────────────
// Unified header — one band, both metrics, one sparkline. Replaces the
// per-kind sections that used to render this region twice.
// ─────────────────────────────────────────────────────────────────────────

function UnifiedAcHeader({
  rows,
  history,
}: {
  rows: AcWithVerification[];
  history: AcAlignmentDay[];
}) {
  const verified = rows.filter((r) => r.verificationState === 'verified');
  const failing = rows.filter((r) => r.verificationState === 'failing');
  const untested = rows.filter((r) => r.verificationState === 'untested');
  const stale = rows.filter((r) => r.verificationState === 'stale');
  const total = rows.length;

  // Two metrics, both load-bearing:
  //   coverage    = ACs with at least one test / total. Drives the
  //                 "ask the agent to add tests or drop frivolous ACs"
  //                 conversation. Upstream of verification — you can't
  //                 verify what isn't covered.
  //   verification = ACs that pass / ACs that have tests. The classic
  //                 "are we honouring our claims" headline. Denominator is
  //                 covered ACs, not total — otherwise an untested-heavy
  //                 spec reads as a failing spec, which it isn't.
  const covered = rows.filter((r) => r.tests.length > 0);
  const pctCovered = total === 0 ? 0 : Math.round((covered.length / total) * 100);
  const pctVerified =
    covered.length === 0 ? 0 : Math.round((verified.length / covered.length) * 100);
  const lastVerified = lastVerifiedAt(rows);
  const allUntested = covered.length === 0;

  return (
    <div
      data-testid="ac-unified-header"
      className="mb-6 rounded-md bg-zinc-50 dark:bg-zinc-900/50 p-4"
    >
      {allUntested ? (
        // ACs exist but ZERO have tests. Not a failure — usually the
        // normal starting state right after ACs are committed. Frame it
        // accordingly, encouragingly, so the manager sees the next action
        // (wire up tests) rather than a system breakage.
        <div>
          <div className="text-2xl font-semibold text-amber-600 dark:text-amber-400 mb-1">
            {total} committed · 0 covered
          </div>
          <p className="text-sm text-body">
            ACs are written but no test yet asserts any of them. This is the
            normal starting state — the next step is wiring tests in the
            codebase to each AC. Ask the embedded agent for help, or consult
            the <code>ac-emission</code> topic via <code>get_information</code>.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          {/* Coverage — upstream metric. Amber when low, green when high. */}
          <Metric
            label="covered"
            percent={pctCovered}
            colourClass={
              pctCovered >= 80 ? 'green' : pctCovered >= 50 ? 'amber' : 'amberWarm'
            }
            caption={
              untested.length === 0
                ? `All ${covered.length} ACs have tests`
                : `${covered.length} of ${total} ACs have tests · ${untested.length} uncovered`
            }
          />
          {/* Verification — downstream metric. Always green-tinted on the
              headline number ("do the tests pass?"), but the bar splits
              into segments so failing (rose) and stale (amber) ACs surface
              instead of hiding inside the empty grey track. The denominator
              is `covered`, so the three segments sum to 100% of the bar by
              construction (every covered AC is in exactly one of the
              three buckets). */}
          <Metric
            label="verified"
            percent={pctVerified}
            colourClass="green"
            segments={buildVerifiedSegments(
              verified.length,
              failing.length,
              stale.length,
              covered.length,
            )}
            caption={
              failing.length > 0
                ? `${verified.length} of ${covered.length} covered ACs pass · ${failing.length} failing`
                : `${verified.length} of ${covered.length} covered ACs pass${
                    stale.length > 0 ? ` · ${stale.length} stale` : ''
                  }`
            }
            extra={
              lastVerified ? `last verified ${relativeTime(lastVerified)}` : undefined
            }
          />
        </div>
      )}
      {history.length > 0 && !allUntested && (
        <div className="mt-4 text-green-600 dark:text-green-400">
          <AcSparkline data={history} height={48} />
          <div className="text-xs text-muted mt-1 flex justify-between">
            <span>{history[0]?.date}</span>
            <span>today</span>
          </div>
        </div>
      )}
    </div>
  );
}

// Single metric tile used in the unified header band.
// `colourClass` keys are limited to keep the palette consistent across the
// tab — "green" for the headline-positive metric, "amber"/"amberWarm" for
// metrics that surface an action the manager can take (raise coverage).
type MetricColour = 'green' | 'amber' | 'amberWarm';
const METRIC_NUMBER_CLASS: Record<MetricColour, string> = {
  green: 'text-green-600 dark:text-green-400',
  amber: 'text-amber-500 dark:text-amber-400',
  amberWarm: 'text-amber-600 dark:text-amber-500',
};

// Bar segment colour key. Extends MetricColour with `rose` so the verified
// bar can surface failing ACs as a red segment instead of hiding them in
// the empty grey track.
type BarColour = 'green' | 'rose' | 'amber' | 'amberWarm';
const BAR_COLOUR_CLASS: Record<BarColour, string> = {
  green: 'bg-green-500',
  rose: 'bg-rose-500',
  amber: 'bg-amber-400',
  amberWarm: 'bg-amber-500',
};

interface BarSegment {
  /** Percent of the FULL bar width. Segments sum to ≤100 with the remainder
   *  left as the grey track. */
  percent: number;
  colour: BarColour;
  /** Optional test hook so we can assert which segment is which without
   *  reading tailwind class names. */
  testId?: string;
}

/**
 * Build the three-segment composition for the verified bar.
 *
 * Each covered AC sits in exactly one verification state — verified, failing,
 * or stale — so the three segments sum to 100% of the bar (no grey
 * remainder). Zero-count segments are dropped so the bar doesn't carry
 * meaningless empty divs. Percentages are raw ratios × 100 so rounding
 * doesn't push the total above 100 and visually overflow the track.
 */
export function buildVerifiedSegments(
  verifiedCount: number,
  failingCount: number,
  staleCount: number,
  coveredCount: number,
): BarSegment[] {
  if (coveredCount === 0) return [];
  const ratio = (n: number): number => (n / coveredCount) * 100;
  const segments: BarSegment[] = [];
  if (verifiedCount > 0) {
    segments.push({
      percent: ratio(verifiedCount),
      colour: 'green',
      testId: 'bar-segment-verified',
    });
  }
  if (failingCount > 0) {
    segments.push({
      percent: ratio(failingCount),
      colour: 'rose',
      testId: 'bar-segment-failing',
    });
  }
  if (staleCount > 0) {
    segments.push({
      percent: ratio(staleCount),
      colour: 'amber',
      testId: 'bar-segment-stale',
    });
  }
  return segments;
}

function Metric({
  label,
  percent,
  colourClass,
  segments,
  caption,
  extra,
}: {
  label: string;
  percent: number;
  /** Colour of the headline number on the left. */
  colourClass: MetricColour;
  /** Optional: stacked segments rendered across the bar. When omitted, the
   *  bar shows a single `percent`-wide fill in `colourClass`. Used by the
   *  verified metric to expose failing (rose) and stale (amber) ACs as
   *  visible chunks rather than empty grey space. */
  segments?: BarSegment[];
  caption: string;
  extra?: string;
}) {
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <div
          className={`text-3xl font-bold tabular-nums ${METRIC_NUMBER_CLASS[colourClass]}`}
        >
          {percent}%
        </div>
        <div className={`text-sm ${METRIC_NUMBER_CLASS[colourClass]} opacity-80`}>
          {label}
        </div>
      </div>
      <div
        className="mt-2 h-2 rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden flex"
        data-testid={`metric-bar-${label}`}
      >
        {segments
          ? segments.map((seg, i) => (
              <div
                key={i}
                data-testid={seg.testId}
                data-segment-colour={seg.colour}
                className={`h-full ${BAR_COLOUR_CLASS[seg.colour]} transition-all`}
                style={{ width: `${seg.percent}%` }}
              />
            ))
          : (
              <div
                className={`h-full ${BAR_COLOUR_CLASS[colourClass]} transition-all`}
                style={{ width: `${percent}%` }}
              />
            )}
      </div>
      <div className="mt-1 text-xs text-muted flex items-center gap-3 flex-wrap">
        <span>{caption}</span>
        {extra && <span className="opacity-60">{extra}</span>}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Unified AC list — flat, failing-first, kind shown as a small badge.
// ─────────────────────────────────────────────────────────────────────────

function sortAcsForUnifiedView(
  rows: AcWithVerification[],
): AcWithVerification[] {
  return [...rows].sort((a, b) => {
    const order = STATE_ORDER[a.verificationState] - STATE_ORDER[b.verificationState];
    if (order !== 0) return order;
    // Within a bucket: scope first (the manager-authored outcomes), then
    // implementation (the agent-spawned mechanisms), and by seq inside each.
    // Doesn't affect the visual story — just keeps the order deterministic
    // across polls.
    if (a.ac.kind !== b.ac.kind) {
      return a.ac.kind === 'scope' ? -1 : 1;
    }
    return a.ac.seq - b.ac.seq;
  });
}

function KindBadge({ kind }: { kind: 'scope' | 'implementation' }) {
  // Tiny lowercase pill next to the ac-N handle. Two shades so the eye can
  // partition the list by kind when it wants to, without the bigger visual
  // tax of a per-kind section split. May be removed in a future pass if it
  // stops earning the pixels.
  const cls =
    kind === 'scope'
      ? 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300'
      : 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300';
  return (
    <span
      data-ac-kind={kind}
      className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium tracking-wide ${cls}`}
    >
      {kind === 'scope' ? 'scope' : 'impl'}
    </span>
  );
}

function UnifiedAcList({
  rows,
  onInvestigate,
}: {
  rows: AcWithVerification[];
  onInvestigate: (row: AcWithVerification) => void;
}) {
  const sorted = sortAcsForUnifiedView(rows);

  return (
    <ul className="space-y-2" data-testid="ac-unified-list">
      {sorted.map((r) => (
        <li
          key={r.ac.id}
          data-ac-id={r.ac.id}
          data-ac-state={r.verificationState}
          className="rounded-md border border-zinc-200 dark:border-zinc-800 p-3 transition-shadow"
        >
          <div className="flex items-start gap-3">
            <span
              className={`mt-1.5 inline-block h-2.5 w-2.5 rounded-sm ${STATE_COLOURS[r.verificationState]}`}
              aria-hidden
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-mono text-muted">ac-{r.ac.seq}</span>
                <KindBadge kind={r.ac.kind} />
              </div>
              <div className="text-base text-body">{r.ac.statement}</div>
              <AcRowMeta row={r} onInvestigate={onInvestigate} />
              <AcMatrixCollapsible acId={r.ac.id} testCount={r.tests.length} />
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function AcRowMeta({
  row,
  onInvestigate,
}: {
  row: AcWithVerification;
  onInvestigate: (row: AcWithVerification) => void;
}) {
  const passing = row.tests.filter((t) => t.latestStatus === 'pass').length;
  const failingCount = row.tests.filter(
    (t) => t.latestStatus === 'fail' || t.latestStatus === 'error',
  ).length;
  const latestRun = row.tests.reduce<Date | null>((acc, t) => {
    const at = new Date(t.latestRunAt);
    return acc === null || at > acc ? at : acc;
  }, null);

  return (
    <div className="mt-2 text-xs text-muted flex flex-wrap items-center gap-x-3 gap-y-1">
      {row.tests.length === 0 ? (
        <span>No test in the codebase asserts this yet.</span>
      ) : (
        <>
          <span>
            {row.tests.length} test{row.tests.length === 1 ? '' : 's'}
          </span>
          {failingCount > 0 && (
            <span>
              {passing} passing · {failingCount} failing
            </span>
          )}
          {failingCount === 0 && passing > 0 && <span>{passing} passing</span>}
          {latestRun && <span>last run {relativeTime(latestRun)}</span>}
          {row.daysSinceLastRun !== null && row.daysSinceLastRun > 7 && (
            <span className="text-amber-600 dark:text-amber-400">
              stale: {row.daysSinceLastRun}d since last run
            </span>
          )}
        </>
      )}
      <span className="text-muted opacity-60">{STATE_LABEL[row.verificationState]}</span>
      {row.verificationState === 'failing' && (
        <button
          onClick={() => onInvestigate(row)}
          className="text-blue-600 dark:text-blue-400 hover:underline"
        >
          investigate →
        </button>
      )}
    </div>
  );
}

export function AcPanel({ docId, focusedAcId, onFocusConsumed }: AcPanelProps) {
  const [rows, setRows] = useState<AcWithVerification[] | null>(null);
  const [history, setHistory] = useState<AcAlignmentDay[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const chat = useChat();
  const fetchInFlight = useRef(false);

  // Loader — used by initial fetch and the poll tick. Guarded against
  // overlap (a slow round-trip shouldn't pile up timers).
  const load = useCallback(async () => {
    if (fetchInFlight.current) return;
    fetchInFlight.current = true;
    try {
      const [snap, hist] = await Promise.all([
        fetchAcsForBrief(docId),
        fetchAcAlignmentHistory(docId, 30),
      ]);
      setRows(snap);
      setHistory(hist);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      fetchInFlight.current = false;
    }
  }, [docId]);

  // Initial fetch + polling. Polling pauses when the tab is hidden via the
  // Page Visibility API so a backgrounded tab doesn't burn cycles.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    void load();
    const start = () => {
      if (timer !== null) return;
      timer = setInterval(() => {
        void load();
      }, POLL_INTERVAL_MS);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisChange = () => {
      if (document.visibilityState === 'visible') {
        // Refresh immediately on tab-show + resume polling.
        void load();
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisChange);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisChange);
    };
  }, [load]);

  // Cross-tab focus: when DocDocument sets focusedAcId (because the user
  // clicked a pill on the Decisions strip), find the matching row in the
  // DOM, scroll it into view, and flash a ring on it. Wait one tick for
  // the panel to render before querying. Imperative because the row
  // element is rendered by deeply-nested children and a ref would have to
  // be threaded through multiple components for no real gain.
  useEffect(() => {
    if (!focusedAcId || rows === null) return;
    const t = setTimeout(() => {
      const el = document.querySelector<HTMLElement>(
        `[data-ac-id="${focusedAcId}"]`,
      );
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Tailwind ring classes — flash for ~1.8s, then settle.
        el.classList.add(
          'ring-2',
          'ring-amber-400',
          'ring-offset-2',
          'ring-offset-transparent',
        );
        setTimeout(() => {
          el.classList.remove(
            'ring-2',
            'ring-amber-400',
            'ring-offset-2',
            'ring-offset-transparent',
          );
        }, 1800);
      }
      onFocusConsumed?.();
    }, 100);
    return () => clearTimeout(t);
  }, [focusedAcId, rows, onFocusConsumed]);

  const handleInvestigate = useCallback(
    (row: AcWithVerification) => {
      // Drop the AC ref into the embedded chat's context. Phase 2 wires the
      // agent to actually investigate; phase 1 just routes the manager into
      // the conversation surface that already exists.
      chat.addContextChip({
        type: 'ac',
        id: row.ac.id,
        label: `ac-${row.ac.seq}`,
      });
    },
    [chat],
  );

  if (rows === null) {
    return (
      <div className="px-2 py-10 text-sm text-muted">Loading acceptance criteria…</div>
    );
  }

  const aboutDialog = aboutOpen ? (
    <AcAboutDialog rows={rows} onClose={() => setAboutOpen(false)} />
  ) : null;

  // Whole-tab empty state — the teaching moment for a Spec with zero ACs
  // of either kind. Different from the per-section empty (which is a slim
  // one-liner): this one introduces the concept AND points at the first
  // action so the manager / agent doesn't bounce.
  //
  // Rendered inside the same card chrome (border + uppercase header + counts
  // line) as the populated panel and the DecisionPanel it sits beside, so
  // the two-column Plan layout reads as one family of component rather than
  // a free-floating grey box next to a proper card. The teaching copy is the
  // card body; the chrome is copied from DecisionPanel (border-edge, bg-panel,
  // text-heading uppercase header, text-muted counts line).
  if (rows.length === 0) {
    return (
      <div className="px-2 py-4 max-w-3xl">
        <div className="border rounded-lg p-5 border-edge bg-panel relative">
          <button
            onClick={() => setAboutOpen(true)}
            className="absolute top-3 right-3 p-1 rounded-md text-muted hover:text-primary hover:bg-overlay transition-colors"
            aria-label="About this view"
            title="About this view"
          >
            <InfoIcon />
          </button>
          <div className="flex items-center justify-between mb-2 pr-8">
            <h3 className="text-sm font-semibold text-heading uppercase tracking-wider">
              Acceptance Criteria
            </h3>
            <span className="text-xs text-muted">0 criteria</span>
          </div>
          <div className="text-sm text-body">
            <h2 className="text-base font-semibold text-heading mb-2">
              No acceptance criteria on this Spec yet
            </h2>
            <p className="mb-3">
              Acceptance criteria are forward-facing claims about what your
              system must do. Each AC is paired with one or more tests in the
              codebase, and this tab shows whether the codebase still honours
              each claim — proven by a test, drifted, or not yet linked.
            </p>
            <p className="mb-3">
              Two flavours travel together:
            </p>
            <ul className="list-disc pl-5 mb-3 space-y-1">
              <li>
                <span className="font-medium">Scope ACs</span> — plain-English
                outcome commitments authored by you, the manager. They define
                what success looks like for this Spec.
              </li>
              <li>
                <span className="font-medium">Implementation ACs</span> —
                technical assertions, typically spawned by the agent from each
                resolved Decision. They're the granular claims that, taken
                together, fulfil the Scope ACs.
              </li>
            </ul>
            <p className="text-muted">
              Ask the embedded agent to draft Scope ACs from this Spec's
              purpose, or use <code>create_ac</code> from any MCP client.
            </p>
          </div>
        </div>
        {aboutDialog}
      </div>
    );
  }

  return (
    <div className="px-2 py-4 max-w-5xl">
      {/* Framing line — anchors the novel mental model. Permanent header,
          not a dismissable tutorial banner. The info button next to it opens
          the AcAboutDialog for the longer explanation. */}
      <div className="mb-6 rounded-md bg-zinc-50 dark:bg-zinc-900/50 px-4 py-3 text-sm text-body relative pr-12">
        Each acceptance criterion is a claim about what your system must do.
        Status shows whether the codebase still honours the claim —{' '}
        <span className="text-green-600 dark:text-green-400 font-medium">
          confirmed by a test
        </span>
        ,{' '}
        <span className="text-zinc-500 dark:text-zinc-400 font-medium">
          drifted
        </span>
        , or{' '}
        <span className="text-amber-600 dark:text-amber-400 font-medium">
          not yet linked
        </span>
        .
        <button
          onClick={() => setAboutOpen(true)}
          className="absolute top-2.5 right-2.5 p-1 rounded-md text-muted hover:text-primary hover:bg-overlay transition-colors"
          aria-label="About this view"
          title="About this view"
        >
          <InfoIcon />
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 px-4 py-2 text-sm text-red-700 dark:text-red-300">
          Couldn't refresh AC data: {error}
        </div>
      )}

      <UnifiedAcHeader rows={rows} history={mergeAlignmentHistory(history)} />
      <UnifiedAcList rows={rows} onInvestigate={handleInvestigate} />

      {aboutDialog}
    </div>
  );
}

function InfoIcon() {
  return (
    <svg
      className="w-4 h-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <circle cx="12" cy="12" r="9" />
      <path strokeLinecap="round" d="M12 8h.01" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 12v4" />
    </svg>
  );
}
