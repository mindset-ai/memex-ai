// spec-552 t-3 (dec-1, dec-6, dec-8, dec-9) — what Memex sent this Memex's agents.
//
// One read-only aggregate over mcp_tool_calls, feeding the ninth Insights card.
// Everything here is CHARACTERS: we store lengths, and the chars→tokens
// conversion is a display concern the UI owns (dec-5, packages/ui/.../tokenEstimate.ts).
//
// THE PAYLOAD HAS TWO HALVES and only one is stored. result_text_length is the
// whole response; footer_text_length is the platform guidance inside it. The
// ANSWER half is DERIVED — result − footer — so the two can never disagree.
//
// n COUNTS THE MEASURED POPULATION, not the call population. Rows written
// before migration 0144 carry a NULL result_text_length; percentile_cont skips
// NULLs and count(*) does not, so a 30-day window straddling the deploy would
// report "400 calls" beside a median drawn from the 120 rows that have a
// length. count(result_text_length) makes n and the median describe the same set.
//
// GROUPING IS (tool_name, verb). Today verb is NULL everywhere and this
// degenerates to tool_name — exactly today's behaviour. After spec-511 renames
// 68 tools into ~25 verb-dispatched ones, it keeps `decision · resolve` (median
// ~3,030 tokens) apart from `decision · update` (~548), a 5.5x spread that a
// single collapsed row would average into a wrong number.
//
// [per std-39] the read is driven by the existing (memex_id, created_at) index.
// No new index and no cache without a measurement — the read is authenticated
// and tenant-scoped, so there is no abuse exposure to bound, only latency.

import { sql } from "drizzle-orm";
import { db } from "../db/connection.js";

/** The window every figure on the card is measured over. */
export const COST_PANEL_WINDOW_DAYS = 30;

export interface CostPanelOperation {
  /** The wire tool name. */
  tool: string;
  /** The operation within that tool — NULL until tools are verb-dispatched. */
  verb: string | null;
  /** Calls that carry a measurable length (see the migration-straddle note). */
  calls: number;
  /** Median total response size, in characters. */
  medianChars: number;
  /** p90 total response size, in characters. */
  p90Chars: number;
  /** Platform guidance across those calls, in characters. */
  guidanceChars: number;
  /** Whole responses across those calls, in characters. */
  totalChars: number;
}

export interface CostPanelTotals {
  calls: number;
  totalChars: number;
  guidanceChars: number;
}

export interface CostPanelData {
  windowDays: number;
  totals: CostPanelTotals;
  operations: CostPanelOperation[];
}

interface Row {
  tool: string;
  verb: string | null;
  calls: number;
  median_chars: number;
  p90_chars: number;
  guidance_chars: number;
  total_chars: number;
}

export async function costPanel(memexId: string): Promise<CostPanelData> {
  // NOTE the cast shape: this driver returns the ROWS, not a { rows } envelope.
  // Assuming the envelope (another driver's convention) yields an empty result
  // with no error — a silently blank card, which is why the aggregate tests
  // assert real numbers rather than just a 200.
  const rows = (await db.execute(sql`
    SELECT
      tool_name                                         AS tool,
      verb                                              AS verb,
      count(result_text_length)::int                    AS calls,
      percentile_cont(0.5) WITHIN GROUP (
        ORDER BY result_text_length
      )::int                                            AS median_chars,
      percentile_cont(0.9) WITHIN GROUP (
        ORDER BY result_text_length
      )::int                                            AS p90_chars,
      coalesce(sum(footer_text_length), 0)::bigint      AS guidance_chars,
      coalesce(sum(result_text_length), 0)::bigint      AS total_chars
    FROM mcp_tool_calls
    WHERE memex_id = ${memexId}
      AND created_at >= now() - (${COST_PANEL_WINDOW_DAYS} || ' days')::interval
      AND result_text_length IS NOT NULL
    GROUP BY tool_name, verb
    ORDER BY sum(result_text_length) DESC
  `)) as unknown as Row[];

  const operations: CostPanelOperation[] = rows.map((r) => ({
    tool: r.tool,
    verb: r.verb,
    calls: Number(r.calls),
    medianChars: Number(r.median_chars),
    p90Chars: Number(r.p90_chars),
    guidanceChars: Number(r.guidance_chars),
    totalChars: Number(r.total_chars),
  }));

  const totals = operations.reduce<CostPanelTotals>(
    (acc, op) => ({
      calls: acc.calls + op.calls,
      totalChars: acc.totalChars + op.totalChars,
      guidanceChars: acc.guidanceChars + op.guidanceChars,
    }),
    { calls: 0, totalChars: 0, guidanceChars: 0 }
  );

  return { windowDays: COST_PANEL_WINDOW_DAYS, totals, operations };
}
