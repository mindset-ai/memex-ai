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
  acceptAc,
  unacceptAc,
  type AcWithVerification,
  type AcAlignmentDay,
  type AcVerificationState,
} from '../api/client';
import { useChat } from './ChatContext';
import { AcSparkline } from './AcSparkline';
import { AcAboutDialog } from './AcAboutDialog';
import { AcMatrixCollapsible } from './AcMatrixCollapsible';
import { PromptButton } from './PromptButton';
import { phaseDisplayName } from '../utils/phaseDisplay';
import { Metric, type BarSegment } from './MetricBar';
import type { GuidanceBlock } from '@memex/shared';

interface AcPanelProps {
  docId: string;
  /** Set by parent (DocDocument) when arriving at this tab via a click on a
   *  DecisionAcStrip pill. AcPanel scrolls the matching row into view and
   *  flashes a highlight ring, then calls onFocusConsumed so a tab re-visit
   *  doesn't re-trigger the highlight. */
  focusedAcId?: string | null;
  onFocusConsumed?: () => void;
  /**
   * spec-164 dec-3: the Spec's current phase. While the Spec is still in
   * `draft` AND no ACs exist, the panel gates the *invitation* — an
   * empty-state directive pointing at the move to Specify — instead of the
   * zero-AC teaching card. ACs that already exist always render.
   */
  specPhase?: string;
  /**
   * spec-247 dec-4: interpolation context ({namespace}/{memex}/{handle}/…) for
   * the "Wire the AC tests" boundary PromptButton. Wiring tests is
   * coding-agent work; the panel hands off instead of naming MCP tools at the
   * human. Absent (isolated tests), the marker is omitted.
   */
  promptContext?: Record<string, unknown>;
  /** Org scaffold appends threaded into toButtonPrompt (spec-159 ac-17). */
  orgBlocks?: readonly GuidanceBlock[];
}

const POLL_INTERVAL_MS = 3_000;

// Palette deliberately kept warm, not strident. Failing uses rose-500
// (softer than red-500 — recognisably "broken" without the glare of
// danger-red). Untested + stale stay quiet but distinct from each other.
// Accepted (spec-188 dec-1) is sky-blue — deliberately distinct from
// test-verified green so human judgement never masquerades as test evidence.
const STATE_COLOURS: Record<AcVerificationState, string> = {
  verified: 'bg-green-500',
  failing: 'bg-rose-500',
  untested: 'bg-zinc-300',
  stale: 'bg-amber-400',
  accepted: 'bg-sky-500',
};

const STATE_LABEL: Record<AcVerificationState, string> = {
  verified: 'verified',
  failing: 'failing',
  untested: 'untested',
  stale: 'stale',
  accepted: 'accepted',
};

// Failing first, then degrees of needs-attention, then the calm verified mass
// (accepted sits with it — both are "honoured claims"). Within each bucket the
// original seq order is preserved so rows don't shuffle on every poll tick.
const STATE_ORDER: Record<AcVerificationState, number> = {
  failing: 0,
  stale: 1,
  untested: 2,
  accepted: 3,
  verified: 4,
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
  promptContext,
  orgBlocks,
}: {
  rows: AcWithVerification[];
  history: AcAlignmentDay[];
  promptContext?: Record<string, unknown>;
  orgBlocks?: readonly GuidanceBlock[];
}) {
  const verified = rows.filter((r) => r.verificationState === 'verified');
  const failing = rows.filter((r) => r.verificationState === 'failing');
  const untested = rows.filter((r) => r.verificationState === 'untested');
  const stale = rows.filter((r) => r.verificationState === 'stale');
  const accepted = rows.filter((r) => r.verificationState === 'accepted');
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
  //
  // spec-188 dec-1: manually-accepted ACs count toward the verified headline —
  // they join both the numerator and the denominator (an accepted AC usually
  // has no tests, so it wouldn't otherwise appear in either). The four states
  // verified / failing / stale / accepted partition that denominator exactly.
  const covered = rows.filter((r) => r.tests.length > 0);
  const pctCovered = total === 0 ? 0 : Math.round((covered.length / total) * 100);
  const testDerivedCount = verified.length + failing.length + stale.length;
  const accountable = testDerivedCount + accepted.length;
  const pctVerified =
    accountable === 0
      ? 0
      : Math.round(((verified.length + accepted.length) / accountable) * 100);
  const lastVerified = lastVerifiedAt(rows);
  const allUntested = covered.length === 0 && accepted.length === 0;

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
        //
        // spec-247 dec-4 / ac-14: wiring tests is coding-agent work, so the
        // copy says where it happens and the PromptButton hands it off. The
        // old copy told the HUMAN to call get_information (an MCP tool) —
        // that mention now lives inside the prompt, agent-facing.
        <div>
          <div className="text-2xl font-semibold text-amber-600 dark:text-amber-400 mb-1">
            {total} committed · 0 covered
          </div>
          <p data-testid="ac-untested-copy" className="text-sm text-body">
            ACs are written but no test yet asserts any of them. This is the
            normal starting state — the next step is wiring tests to each AC,
            and that happens from your coding agent, not in the browser.
          </p>
          {promptContext && (
            <div data-testid="ac-wire-tests-marker" className="mt-2">
              <PromptButton
                buttonId="wire-ac-tests"
                context={promptContext}
                orgBlocks={orgBlocks}
                linkText="Wire the AC tests"
                sentence="— copy this prompt into your coding agent to connect each AC to a real test."
                sentenceLabel="Wire the AC tests — copy this prompt into your coding agent to connect each AC to a real test."
              />
            </div>
          )}
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
              testDerivedCount,
              accepted.length,
            )}
            caption={[
              `${verified.length} of ${covered.length} covered ACs pass`,
              accepted.length > 0
                ? `${accepted.length} accepted`
                : null,
              failing.length > 0 ? `${failing.length} failing` : null,
              failing.length === 0 && stale.length > 0
                ? `${stale.length} stale`
                : null,
            ]
              .filter(Boolean)
              .join(' · ')}
            extra={
              lastVerified ? `last verified ${relativeTime(lastVerified)}` : undefined
            }
          />
        </div>
      )}
      {/* spec-247 dec-4 / ac-14: the partially-covered state still has an
          MCP-only next step (the uncovered ACs need tests wired) — same
          handoff, scoped to the gap. */}
      {!allUntested && untested.length > 0 && promptContext && (
        <div data-testid="ac-coverage-marker" className="mt-3">
          <PromptButton
            buttonId="wire-ac-tests"
            context={promptContext}
            orgBlocks={orgBlocks}
            linkText="Wire the remaining AC tests"
            sentence={`— ${untested.length} AC${untested.length === 1 ? ' has' : 's have'} no test yet; copy this prompt into your coding agent.`}
            sentenceLabel="Wire the remaining AC tests — copy this prompt into your coding agent."
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

/**
 * Build the segment composition for the verified bar.
 *
 * Each AC in the denominator sits in exactly one verification state —
 * verified, failing, stale, or accepted — so the segments sum to 100% of the
 * bar (no grey remainder). Zero-count segments are dropped so the bar doesn't
 * carry meaningless empty divs. Percentages are raw ratios × 100 so rounding
 * doesn't push the total above 100 and visually overflow the track.
 *
 * `coveredCount` is the count of ACs in a TEST-derived state (verified +
 * failing + stale). Manually-accepted ACs (spec-188) are passed separately
 * via `acceptedCount` and extend the denominator — green leads the bar, the
 * sky-blue accepted segment follows it, then the attention colours.
 */
export function buildVerifiedSegments(
  verifiedCount: number,
  failingCount: number,
  staleCount: number,
  coveredCount: number,
  acceptedCount = 0,
): BarSegment[] {
  const denominator = coveredCount + acceptedCount;
  if (denominator === 0) return [];
  const ratio = (n: number): number => (n / denominator) * 100;
  const segments: BarSegment[] = [];
  if (verifiedCount > 0) {
    segments.push({
      percent: ratio(verifiedCount),
      colour: 'green',
      testId: 'bar-segment-verified',
    });
  }
  if (acceptedCount > 0) {
    segments.push({
      percent: ratio(acceptedCount),
      colour: 'sky',
      testId: 'bar-segment-accepted',
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
  onAcceptToggle,
}: {
  rows: AcWithVerification[];
  onInvestigate: (row: AcWithVerification) => void;
  /** spec-188: accept / un-accept handler. Resolves when the panel has
   *  refreshed; rejections surface as inline errors on the toggle. */
  onAcceptToggle: (row: AcWithVerification) => Promise<void>;
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
              {/* spec-188 (ac-1): the accept action sits alongside the
                  test-history toggle. The collapsible keeps the full row
                  width (flex-1) so its expanded matrix isn't squeezed. */}
              <div className="flex items-start gap-4">
                <div className="flex-1 min-w-0">
                  <AcMatrixCollapsible acId={r.ac.id} testCount={r.tests.length} />
                </div>
                <AcAcceptToggle row={r} onToggle={onAcceptToggle} />
              </div>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

// spec-188 (ac-1 / ac-10): "Mark as accepted" / "Un-accept" — the manual
// verification override for ACs a digital test can't exercise. The button
// reflects whether an acceptance RECORD exists (ac.acceptedAt), not the
// derived state — an accepted-but-suppressed AC (failing evidence) still
// shows "Un-accept" so the override stays discoverable and revocable.
function AcAcceptToggle({
  row,
  onToggle,
}: {
  row: AcWithVerification;
  onToggle: (row: AcWithVerification) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Loose `!= null` so a payload missing the field (older fixture/cached
  // response) reads as "no acceptance", never as an accepted AC.
  const hasAcceptance = row.ac.acceptedAt != null;

  const handleClick = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onToggle(row);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 shrink-0 text-right">
      {/* spec-247 dec-4 / ac-14: this is the one HUMAN-clickable state change
          on an AC row — everything else (verified / failing / stale) is fed by
          tests from the coding agent and can't be changed here. The person
          glyph marks the boundary visually; the title says it in words. */}
      <button
        type="button"
        onClick={() => void handleClick()}
        disabled={busy}
        data-testid={hasAcceptance ? 'ac-unaccept-button' : 'ac-accept-button'}
        title={
          hasAcceptance
            ? 'Human action: revoke the manual acceptance and restore the test-derived state (test states themselves are set by tests from your coding agent)'
            : "Human action: record an acceptance for a criterion a digital test can't verify. Test-derived states (verified / failing / stale) are set by tests from your coding agent, not here."
        }
        className="inline-flex items-center gap-1 text-xs text-sky-600 dark:text-sky-400 hover:underline disabled:opacity-50"
      >
        <svg
          className="w-3 h-3"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </svg>
        {busy ? '…' : hasAcceptance ? 'Un-accept' : 'Mark as accepted'}
      </button>
      {error && (
        <div className="mt-1 text-xs text-rose-600 dark:text-rose-400">{error}</div>
      )}
    </div>
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
      {/* spec-188 (ac-8): acceptance provenance. Shown whenever the record
          exists — including while failing evidence suppresses the derived
          state, where the suffix names the conflict instead of hiding it. */}
      {row.ac.acceptedAt && (
        <span
          data-testid="ac-accepted-provenance"
          className="text-sky-600 dark:text-sky-400"
        >
          accepted by {row.ac.acceptedBy ?? 'unknown'} ·{' '}
          {new Date(row.ac.acceptedAt).toLocaleDateString(undefined, {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
          })}
          {row.verificationState === 'failing' && ' (suppressed by failing tests)'}
        </span>
      )}
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

export function AcPanel({ docId, focusedAcId, onFocusConsumed, specPhase, promptContext, orgBlocks }: AcPanelProps) {
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

  // spec-188: accept / un-accept, then refresh immediately so the row, the
  // header metrics and the bar all reflect the new state without waiting for
  // the next poll tick. Errors propagate to the toggle's inline error state.
  const handleAcceptToggle = useCallback(
    async (row: AcWithVerification) => {
      if (row.ac.acceptedAt != null) {
        await unacceptAc(row.ac.id);
      } else {
        await acceptAc(row.ac.id);
      }
      await load();
    },
    [load],
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
  // spec-164 dec-3: gate the invitation, never the content — a draft Spec
  // with zero ACs invites the move to Specify instead of the teaching card.
  if (specPhase === 'draft' && rows.length === 0) {
    return (
      <div data-testid="ac-panel">
        <div className="border rounded-lg p-5 border-edge bg-panel">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-heading uppercase tracking-wider">
              Acceptance Criteria
            </h3>
            <span className="text-xs text-muted">0 criteria</span>
          </div>
          <p data-testid="ac-draft-directive" className="text-sm text-muted">
            Move this spec to {phaseDisplayName('specify')} to start capturing
            Decisions and ACs.
          </p>
        </div>
      </div>
    );
  }

  // spec-164 (ac-10): no offset wrapper — the card renders flush so the AC
  // column starts on the same line as the Decisions column beside it.
  if (rows.length === 0) {
    return (
      <div data-testid="ac-panel">
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

  // spec-164 (ac-3 / ac-10): the populated panel wears the same card chrome
  // as DecisionPanel / TaskPanel / IssuePanel (border-edge, bg-panel,
  // uppercase header + counts line) and carries no offset wrapper, so the
  // Decisions and ACs columns start on the same line — including when the
  // unified header below shows coverage/verification statistics.
  return (
    <div data-testid="ac-panel" className="border rounded-lg p-5 border-edge bg-panel">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-heading uppercase tracking-wider">
          Acceptance Criteria
        </h3>
        <span className="text-xs text-muted">
          {rows.length} criteri{rows.length === 1 ? 'on' : 'a'}
        </span>
      </div>
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

      <UnifiedAcHeader
        rows={rows}
        history={mergeAlignmentHistory(history)}
        promptContext={promptContext}
        orgBlocks={orgBlocks}
      />
      <UnifiedAcList
        rows={rows}
        onInvestigate={handleInvestigate}
        onAcceptToggle={handleAcceptToggle}
      />

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
