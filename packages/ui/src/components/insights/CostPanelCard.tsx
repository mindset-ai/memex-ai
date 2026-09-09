// spec-552 t-5 — the ninth Insights card: what Memex sent this Memex's agents.
//
// The reader is a person asking a budget question, so the craft here is
// information design rather than typography. Three properties are load-bearing
// and each has a test:
//
//   MEDIAN AND P90, NEVER A BARE MEAN (ac-2). get_doc measures 1,600 tokens at
//   the median and 11,700 at p90 — a factor of seven on one operation. A single
//   number per row tells most readers something false about their own usage.
//
//   ...BUT ONLY WHERE A P90 MEANS SOMETHING (dec-10, ac-23/ac-24). The first
//   real prod read showed ten of twelve rows at n=1, each printing a median and
//   a p90 that were the same observation under two headers. Below
//   MIN_CALLS_FOR_P90 the cell is withheld, because a column header a reader
//   has to discount per row is a header that has stopped working.
//
//   EVERY FIGURE COMES FROM THE RESPONSE (ac-10), the window included. A
//   literal here is a number that stops being true with nothing detecting it —
//   which is the whole argument dec-3 settled.
//
//   ESTIMATES ARE MARKED AND CHARACTERS ARE REACHABLE (ac-13). Tokens are
//   derived from a measured constant, not counted, so no token figure may read
//   as exact; and the character count that IS measured sits on the row, so a
//   reader who distrusts our divisor can recompute rather than take it on faith.
//
// And one thing the card says rather than implies: we do not compare against
// not using Memex, because no honest comparison exists (Overview, question 3).
// A reader seeing a total asks "versus what?" — if the card is silent they
// invent a baseline.
//
// Hues follow theme.ts's fixed semantics [per std-27]: the ANSWER half takes
// the app accent (blue, the "human" hue) and PLATFORM GUIDANCE takes violet
// (the agent/platform hue). Rose stays reserved for failure and amber / cyan /
// emerald for phases; none is borrowed.

import type { CostPanelOperation, CostPanelResponse } from '../../api/insights';
import { estimateTokens } from './tokenEstimate';
import { useChartPalette } from './theme';

/**
 * Below this many measured calls the card shows a state, not a statistic.
 *
 * Mirrors the page's own convention — `MIN_SPECS_FOR_CHARTS` in Insights.tsx
 * withholds every chart under three Specs — rather than inventing a second kind
 * of threshold. The unit differs (calls, not Specs) because that is what this
 * card measures; the rule is the page's.
 */
export const MIN_CALLS_FOR_FIGURES = 3;

/**
 * Below this many calls on ONE OPERATION, that row's p90 is withheld (dec-10).
 *
 * Not a rounder version of the constant above — a different claim. The panel
 * gate asks "does this Memex have enough traffic to show figures at all?"; this
 * asks "does this ROW have enough calls for a 90th percentile to be a statement
 * about variability?" Ten is where the answer turns: below it no observation
 * actually falls in the top decile, so `percentile_cont` is interpolating
 * between the last two values whatever the data does. A p90 there is arithmetic
 * wearing a statistic's label.
 *
 * A plain constant, deliberately. spec-458 dec-1 made its honesty floor
 * env-tunable; the sibling threshold in this very file is a constant, and
 * consistency with the file a reader is looking at beats consistency with
 * another Spec's deployment surface.
 */
export const MIN_CALLS_FOR_P90 = 10;

/**
 * Does ANY row have enough calls to carry a p90? If not, the column is not
 * drawn at all — no header, no cells (dec-10, owner's call 2026-09-09).
 *
 * Withholding a cell is right; leaving a header standing over nothing but em
 * dashes for its whole height is not. A young Memex has every row below the
 * floor, so that is the state it would live in for weeks — and the first thing
 * a reader does with an empty column is wonder what broke. The column comes
 * back on its own the day one operation reaches the floor.
 *
 * This does not weaken ac-2's median-AND-p90 commitment: the p90 is computed,
 * returned by the API for every row, and shown wherever it can mean something.
 * What is gated is drawing a header for a statistic nothing on screen has.
 */
function anyRowEarnsP90(operations: readonly CostPanelOperation[]): boolean {
  return operations.some((op) => op.calls >= MIN_CALLS_FOR_P90);
}

function pct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 100);
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

/** "≈ 1,622" — the marker is not decoration; it is the honesty requirement. */
function approxTokens(chars: number): string {
  return `≈ ${fmt(estimateTokens(chars))}`;
}

interface RowProps {
  op: CostPanelOperation;
  guidanceHue: string;
  track: string;
  /** Whether the table is drawing a p90 column at all (see anyRowEarnsP90). */
  showP90: boolean;
}

function OperationRow({ op, guidanceHue, track, showP90 }: RowProps): React.ReactElement {
  const share = pct(op.guidanceChars, op.totalChars);
  // The high-guidance rows are the actionable ones — those are ours to cut, and
  // spec-510 is the work that cuts them. Emphasis puts them in the eye-line.
  const hot = share >= 75;
  const label = op.verb ? `${op.tool} · ${op.verb}` : op.tool;

  return (
    <tr>
      <td className="py-2 font-mono text-xs text-primary">{label}</td>
      <td className="py-2 text-right font-mono tabular-nums text-primary">
        {fmt(op.calls)}
      </td>
      <td className="py-2 text-right font-mono tabular-nums text-primary">
        {approxTokens(op.medianChars)}
        {/* The measured number, beside the derived one (ac-13). */}
        <span className="ml-2 text-[11px] text-muted">{fmt(op.medianChars)} ch</span>
      </td>
      {showP90 && (
        <td className="py-2 text-right font-mono tabular-nums text-secondary">
          {op.calls >= MIN_CALLS_FOR_P90 ? (
            approxTokens(op.p90Chars)
          ) : (
            <>
              {/* An em dash reads as "deliberately nothing" where a blank reads
                  as broken. The WHY is the call count already on this row, so
                  nothing new is asserted — but a sighted reader gets it from the
                  Calls column and a screen reader gets nothing, hence the
                  spoken-only reason beside it (dec-10, ac-27).

                  The dash is aria-hidden and the reason is not: a reader who
                  can see the dash needs no sentence, and a reader who cannot
                  needs the sentence and not a dash announced as "em dash". */}
              <span aria-hidden="true" className="text-muted">
                &mdash;
              </span>
              <span className="sr-only">Too few calls for a p90</span>
            </>
          )}
        </td>
      )}
      <td className="py-2 pl-4">
        <span className="flex items-center justify-end gap-2">
          <span
            className="h-[5px] flex-1 min-w-[40px] rounded-full overflow-hidden"
            style={{ background: track }}
            aria-hidden="true"
          >
            <span
              className="block h-full rounded-full"
              style={{ width: `${share}%`, background: guidanceHue }}
            />
          </span>
          <span
            className="w-9 text-right font-mono text-xs"
            style={hot ? { color: guidanceHue, fontWeight: 500 } : undefined}
          >
            {share}%
          </span>
        </span>
      </td>
    </tr>
  );
}

export function CostPanelCard({ data }: { data: CostPanelResponse }): React.ReactElement | null {
  const palette = useChartPalette();
  // Answer = the app accent (human hue); guidance = the agent/platform hue.
  const answerHue = palette.actor.human;
  const guidanceHue = palette.actor.mcp_agent;

  // Not available is not a failure: render NOTHING. No placeholder, no error,
  // no empty frame — the page must look exactly as it does today for a Memex
  // outside the rollout or a caller who is not a member (dec-9).
  if (!data.available) return null;

  const { windowDays, totals, operations } = data;
  const guidanceShare = pct(totals.guidanceChars, totals.totalChars);
  const answerShare = 100 - guidanceShare;
  const showP90 = anyRowEarnsP90(operations);

  return (
    <div className="p-5 bg-panel border border-edge rounded-lg">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-sm font-semibold text-heading">
            What Memex sent your agents
          </h2>
          <p className="text-xs text-secondary mt-1">
            Every response has two parts: the answer your agent asked for, and
            the platform guidance we attach.
          </p>
        </div>
        <span className="text-[11px] text-secondary border border-edge rounded-full px-2.5 py-0.5 whitespace-nowrap">
          Last {windowDays} days
        </span>
      </div>

      {totals.calls < MIN_CALLS_FOR_FIGURES ? (
        <div className="text-center py-8">
          <div className="text-sm text-primary font-medium">
            Not enough activity yet
          </div>
          <div className="text-xs text-secondary mt-1">
            Figures appear once this Memex has a few days of agent traffic
            behind it.
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-7 mt-5">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                Sent to your agents
              </div>
              <div className="text-2xl font-semibold text-heading mt-0.5 tabular-nums">
                {approxTokens(totals.totalChars)}{' '}
                <span className="text-sm font-medium text-secondary">tokens</span>
              </div>
              <div className="text-xs text-secondary">
                {fmt(totals.totalChars)} characters
              </div>
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                Of that, platform guidance
              </div>
              <div className="text-2xl font-semibold text-heading mt-0.5 tabular-nums">
                {guidanceShare}
                <span className="text-sm font-medium text-secondary">%</span>
              </div>
              <div className="text-xs text-secondary">
                {approxTokens(totals.guidanceChars)} tokens
              </div>
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                Calls
              </div>
              <div className="text-2xl font-semibold text-heading mt-0.5 tabular-nums">
                {fmt(totals.calls)}
              </div>
              <div className="text-xs text-secondary">
                {operations.length} operations
              </div>
            </div>
          </div>

          <div
            className="flex h-3 gap-0.5 rounded-sm my-4 overflow-hidden"
            role="img"
            aria-label={`${answerShare} percent answers, ${guidanceShare} percent platform guidance`}
          >
            <span
              style={{
                width: `${answerShare}%`,
                background: `${answerHue}2e`,
                boxShadow: `inset 0 0 0 1px ${answerHue}`,
              }}
            />
            <span
              style={{
                width: `${guidanceShare}%`,
                background: `${guidanceHue}2e`,
                boxShadow: `inset 0 0 0 1px ${guidanceHue}`,
              }}
            />
          </div>

          <div className="overflow-x-auto mt-5">
            <table className="w-full text-[13px] border-collapse min-w-[560px]">
              <thead>
                <tr className="text-[10.5px] font-semibold uppercase tracking-wider text-muted">
                  <th className="text-left pb-2 border-b border-edge">Operation</th>
                  <th className="text-right pb-2 border-b border-edge">Calls</th>
                  <th className="text-right pb-2 border-b border-edge">Median</th>
                  {showP90 && (
                    <th className="text-right pb-2 border-b border-edge">p90</th>
                  )}
                  <th className="text-right pb-2 pl-4 border-b border-edge">
                    Guidance
                  </th>
                </tr>
              </thead>
              <tbody>
                {operations.map((op) => (
                  <OperationRow
                    key={`${op.tool}:${op.verb ?? ''}`}
                    op={op}
                    guidanceHue={guidanceHue}
                    track={palette.verification.untested}
                    showP90={showP90}
                  />
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 pt-3 border-t border-edge flex flex-wrap gap-y-2 gap-x-6 justify-between">
            <p className="text-xs text-secondary m-0">
              Tokens are estimated from characters; the exact character counts
              are on each row.
            </p>
            <p className="text-xs text-secondary m-0">
              We don&apos;t compare this with not using Memex — we can&apos;t
              measure that honestly.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
