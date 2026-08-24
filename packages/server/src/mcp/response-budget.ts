// spec-538 t-2 (ac-7, ac-9, ac-10) — the one place that decides how much of a
// doc response may be spent, and on what.
//
// WHY THIS EXISTS. `get_doc({verbose:true})` on a mature Spec returns more than
// the MCP client will accept. The client refuses the result, writes the payload
// to a file, and puts a path in the agent's context instead — so the agent
// orients by grepping a file it never reads. Measured: 23 spilled payloads
// across 14 Specs, 71,292–137,269 chars, and a lost sensitivity warning
// (spec-535 issue-5). This is a DELIVERY defect: nothing placed inside an
// overflowing payload reaches the reader, because the client's own overflow
// message tells the agent to grep the file or hand it to a subagent. Position is
// not the variable. Size is.
//
// ONE CONSTANT, ONE FILE — the shape spec-203 dec-3 established with
// `footer-delimiter.ts`. Everything else in this module is derived from it.

/**
 * The character budget for a single doc-shaped tool response.
 *
 * PROVISIONAL — sized properly in t-6, which measures the maximum guidance
 * envelope by rendering every phase locally. Do not tune it here.
 *
 * What is already known and bounds it:
 *   - The client's cap is BELOW 71,292 chars. That figure is the smallest
 *     payload observed to spill, so it is an upper bound on the cap, not the
 *     cap. The real value is lower, belongs to the client, and is
 *     user-configurable — so this must stay a margin, never an equality.
 *   - Characters are a proxy for tokens. The client counts tokens; we can only
 *     cheaply count characters, and the ratio moves with content (tables and
 *     code tokenize worse than prose). The margin absorbs that too.
 *
 * NOT an environment variable, deliberately (ac-10). The cap is a property of
 * the CLIENT, not of the deployment: one server answers clients with different
 * caps, so a per-environment value would look like tuning while being wrong for
 * half the callers. And we never read the client's cap — we do not know it.
 */
export const RESPONSE_BUDGET_CHARS = 40_000;

/**
 * Below this, an excerpt stops being an excerpt.
 *
 * The derivation can produce an arithmetically valid but useless per-decision
 * length — twelve characters of a resolution is noise wearing an excerpt's
 * clothes. Under the floor a decision renders as headline + ref instead, which
 * is still dec-1's contract (bounded, with a door to the full text) minus a
 * fragment nobody could act on.
 */
export const MIN_EXCERPT_CHARS = 200;

/** Which shape the render must take. dec-4's ladder, decided by arithmetic. */
export type ResponseTier = 1 | 2 | 3;

export interface BudgetInput {
  /** Signals the reader must act on: sensitivity flag, AC-coverage, phase pointer. */
  signalsChars: number;
  /** The composed guidance envelope. Counted INSIDE the budget (dec-2, ac-18). */
  envelopeChars: number;
  /** Section prose — what humans wrote. */
  proseChars: number;
  /** What the decisions block would cost rendered in full. */
  decisionsFullChars: number;
  /** How many decisions that cost is spread across. */
  decisionCount: number;
  /**
   * Optional per-call ceiling. Only the client truly knows its own limit, so
   * accepting one is the theoretically correct shape — but it is never the
   * default: an agent-supplied number is one the agent can omit or get wrong.
   * Anything absent, non-finite, or non-positive falls back to the constant,
   * never to unbounded output (ac-10).
   */
  maxChars?: number;
}

export interface BudgetAllocation {
  /** The ceiling actually applied. */
  budget: number;
  tier: ResponseTier;
  /**
   * Characters each decision's resolution may occupy. `0` means headline + ref
   * only — either the floor bit, or tier 3 where there is nothing left to give.
   */
  perDecisionChars: number;
  /** True when section bodies are rendered; false at tier 3 (map of refs). */
  renderProseBodies: boolean;
  /** What is left after signals + envelope. Negative means even those overflow. */
  remainingAfterFixed: number;
}

/**
 * Resolve the effective ceiling. Exported for the guard test that proves an
 * unusable override cannot widen or disable the bound.
 */
export function effectiveBudget(maxChars?: number): number {
  if (typeof maxChars !== "number") return RESPONSE_BUDGET_CHARS;
  if (!Number.isFinite(maxChars) || maxChars <= 0) return RESPONSE_BUDGET_CHARS;
  return Math.min(maxChars, RESPONSE_BUDGET_CHARS);
}

/**
 * Decide what each part of a doc response may spend.
 *
 * THE DIRECTION IS THE POINT (ac-7). The document total is configured and the
 * per-decision length is DERIVED from what remains. Configuring a per-decision
 * length instead would put the bug back at a higher decision count — 30
 * decisions × 800 chars is 24k of excerpts alone — which is the
 * bounded-on-average, unbounded-in-the-tail shape this Spec exists to remove.
 *
 * ALLOCATION ORDER (ac-9, scope ac-3). Signals come off the top and are never
 * rationed: a response that drops the sensitivity flag to save bytes defeats the
 * purpose of bounding it at all. They are not returned as an allowance because
 * they are not negotiable — they are subtracted, and what is left is the
 * negotiable part.
 */
export function allocateResponseBudget(input: BudgetInput): BudgetAllocation {
  const budget = effectiveBudget(input.maxChars);

  // 1. Signals and the envelope are fixed costs, taken first.
  const fixed = input.signalsChars + input.envelopeChars;
  const remainingAfterFixed = budget - fixed;

  // 2. Section prose — what humans wrote.
  const remainingAfterProse = remainingAfterFixed - input.proseChars;

  // Tier 3: prose alone (on top of the fixed costs) does not fit. Nothing the
  // decisions block does can save this — spec-472's prose is 85,580 chars, more
  // than the whole measured cap on its own. Sections become a map of refs and
  // the decisions keep their headlines.
  if (remainingAfterProse <= 0) {
    return {
      budget,
      tier: 3,
      perDecisionChars: 0,
      renderProseBodies: false,
      remainingAfterFixed,
    };
  }

  // Tier 1: everything fits at full size. Nine Specs in ten are here and their
  // output must not change shape.
  if (input.decisionsFullChars <= remainingAfterProse) {
    return {
      budget,
      tier: 1,
      perDecisionChars: Number.POSITIVE_INFINITY,
      renderProseBodies: true,
      remainingAfterFixed,
    };
  }

  // Tier 2: tight. Divide what is left across the decisions.
  const derived =
    input.decisionCount > 0
      ? Math.floor(remainingAfterProse / input.decisionCount)
      : 0;

  return {
    budget,
    tier: 2,
    // Below the floor an excerpt is a fragment nobody can act on; fall to
    // headline + ref rather than emit noise that still costs bytes.
    perDecisionChars: derived >= MIN_EXCERPT_CHARS ? derived : 0,
    renderProseBodies: true,
    remainingAfterFixed,
  };
}
