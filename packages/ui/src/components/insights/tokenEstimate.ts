// spec-552 t-4 (dec-5) — the one place characters become tokens.
//
// We store characters (telemetry writes lengths, never token counts). Readers
// think in tokens, because that is what their bill and their context window are
// denominated in. This module is the single conversion, so the divisor can be
// re-measured in one edit and every figure re-renders consistently.
//
// ─── PROVENANCE ──────────────────────────────────────────────────────────────
//
// Measured 2026-09-08 with Anthropic's `count_tokens` against **claude-opus-5**,
// over 148 real Memex tool responses — 841,280 characters, 308,135 tokens,
// 56 distinct tools, payloads from 44 to 57,739 characters. The sample was
// stratified per tool (smallest / median / largest response) so the divisor is
// measured across the whole size range, not on whatever happened to be typical.
//
//   aggregate            2.730 chars/token   ← the value below
//   median per payload   2.729               (agrees with the aggregate)
//   p10 / p90            2.175 / 3.043
//   min / max            1.879 / 3.591
//
// ONE CONSTANT IS THE RIGHT SHAPE, and that was an open question rather than an
// assumption. Aggregate ratio by size band: smallest 2.87, median 2.70,
// largest 2.72 — a ~6% spread across three orders of magnitude of payload size.
// A per-tool or per-size divisor would add machinery to chase noise.
//
// The per-tool spread that does exist is explainable and not size-driven: the
// densest payloads are short structured confirmations (`add_section` 1.88 —
// mostly refs and punctuation, which tokenise badly), the loosest are prose-heavy
// bodies (`create_doc` 3.12). Both sit inside p10–p90.
//
// WHY IT IS NOT 3.0. The Evidence section (spec-552 s-2) was drawn at 3.0, chosen
// as a deliberately conservative guess before any measurement existed. The real
// figure is ~10% denser, so those tables UNDERSTATE tokens by about a tenth. An
// earlier calibration from transcript cache-write deltas suggested 2.38; that was
// too low — it swept in assistant output and cache-block rounding. Ratios BETWEEN
// tools (what s-2 argues) are unaffected either way, since they are character
// ratios.
//
// RE-MEASURE WHEN: the guidance envelope changes shape (spec-510's cadence lands),
// the tool surface is renamed (spec-511), or the agent model family changes —
// tokenisation is per-model-family, and this figure is Opus 5's.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Characters per token for Memex tool payloads. See the provenance block above
 * before changing this — it is a measurement, not a preference.
 */
export const CHARS_PER_TOKEN = 2.73;

/**
 * Convert a character count to an approximate token count.
 *
 * Every figure derived from this is an ESTIMATE and must be rendered as one —
 * the card marks them and states the derivation (dec-5). A modelled number
 * presented as exact is how a reader stops trusting the whole surface.
 */
export function estimateTokens(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.round(chars / CHARS_PER_TOKEN);
}
