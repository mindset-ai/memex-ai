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
//
// NAMING, and it is load-bearing — INVERTED by t-15 (ac-28 amended). The budget
// bounds the WHOLE response: the guidance envelope is a fixed cost inside it, not
// a term beyond it.
//
// It was `RESPONSE_BODY_BUDGET_CHARS` under dec-7 option (d), which made it a
// body-only budget and left the envelope in headroom between it and the client's
// cap. That option's arithmetic premise was false against the client's real
// ceiling (dec-7's amendment), and dec-9 replaced the inferred cap with a
// DECLARED one. With the envelope now counted per response, a name saying BODY
// would understate what the number covers — the same trap in the other
// direction, and the class of defect ac-6 exists to clean up.

/**
 * MEASURED, 2026-08-24 (t-6). Two independent bounds, and the window between
 * them is where this number has to sit.
 *
 * All figures come from real MCP responses in local transcripts — the ones that
 * arrived intact and the ones the client refused — split on the footer
 * delimiter, so body and envelope are measured separately rather than assumed.
 *
 *   reads that ARRIVE INTACT   n=18   body max 33,501   p90 31,358   median 13,044
 *   envelopes observed         n=18   max 22,215        median 12,052
 *   smallest read the client REFUSED  70,794            ← an upper bound on
 *                                                       REFUSALS, never the cap
 *                                                       itself (t-12 corrected
 *                                                       this: the real default
 *                                                       is 50,000, READ from the
 *                                                       client, and the operative
 *                                                       ceiling is now DECLARED)
 *
 * There is a clean gap: everything observed working is ≤ 47,561 in total,
 * everything observed failing is ≥ 70,794. Nothing lands between.
 *
 * LOWER BOUND — ac-26, no read that works today may change shape. The largest
 * body that currently arrives is 33,501, so anything at or below that would
 * reshape a response that works fine now. 40,000 clears it by 19%.
 *
 * UPPER BOUND — ac-27. The budget is now INCLUSIVE of the envelope, so the bound
 * is no longer additive: what must fit is one full budget, weighed the way the
 * client weighs it. 58,000 x 1.013 (the JSON-serialisation overhead) = 58,754,
 * which is 6,246 under the 70,000 this server DECLARES less its 5,000 margin.
 *
 * Adding MEASURED_ENVELOPE_MAX_CHARS on top would now DOUBLE-COUNT it. The old
 * additive form was checked against 70,794 — a refusal sample 41.6% above the
 * client's real default — so it held by luck rather than by arithmetic.
 *
 * WHY 58,000 AND NOT 40,000 (t-15). Counting the envelope spends 7,150 (done) to
 * 17,482 (specify) of the budget before any content. At 40,000 that left ~28,000
 * of content against ~36,100 before, and it red ac-29 and both ac-30 assertions —
 * two renders collapsed to an identical 1,469. 58,000 keeps content at or above
 * the old figure in EVERY phase (36,618 at specify, 46,950 at done), which is
 * what ac-26 requires. Both bounds are asserted in the suite, not claimed here.
 *
 * The viable window is roughly 35,501 … 64,165. Move within it freely; leaving it
 * reds a test.
 *
 * CAVEAT ON THE SAMPLE: 18 reads, from one developer's sessions, biased toward
 * the Specs that developer worked on. The margins above are what absorb that.
 *
 * What is already known and bounds it:
 *   - The client's DEFAULT threshold is 50,000, read from the client itself, not
 *     inferred from a refusal (CLIENT_DEFAULT_CEILING_CHARS). This server no
 *     longer depends on it: it DECLARES its own ceiling per dec-9.
 *   - Characters are what the client compares, NOT tokens — corrected in t-12.
 *     The threshold is `l.length` on the JSON-serialised content array. The
 *     earlier "characters are a proxy for tokens" caveat was wrong about the
 *     mechanism; what IS true is that the serialised form runs ~1.3% longer than
 *     the rendered text (688 chars on a 52,559-char payload), because newlines
 *     are escaped. The margin absorbs that.
 *
 * NOT an environment variable, deliberately (ac-10). The ceiling is a property of
 * the CLIENT, not of the deployment: one server answers clients with different
 * thresholds, so a per-environment value would look like tuning while being wrong
 * for half the callers.
 */
export const RESPONSE_BUDGET_CHARS = 58_000;

/**
 * The worst-case guidance envelope, measured by decomposing a real payload:
 * 11,228 phase guidance + 11,950 full handoff prompt + 66 activity. The largest
 * envelope observed independently in transcripts is 22,215, which corroborates
 * it from the other direction.
 *
 * NOT the per-response reserve — t-15 computes that from the phase instead, which
 * is why this stays a reference bound rather than a subtrahend. dec-7 option (d)
 * rejected reserving this figure flat on every call, and that rejection still
 * holds: at ~23,244 against a prod mean of 3,174 and p90 of 14,393, it would pull
 * the majority of reads into tier 2/3 and collide with ac-26.
 *
 * Its remaining job is to bound the seat: if a real composed envelope ever exceeds
 * it, the per-phase drift test reds.
 */
export const MEASURED_ENVELOPE_MAX_CHARS = 23_244;

/**
 * What the render CANNOT compute about its own envelope, reserved on top of what
 * it can — t-15.
 *
 * `formatFullDocState` holds the inputs to the envelope's two dominant terms: the
 * phase guidance (`toNudge` over BASE_SCAFFOLD with this call's `tool` and
 * `orgBlocks`) and the handoff (`nudge.fullHandoff` when the seat is delivering
 * one, else the compressed essence). Measured per phase, `toNudge` alone spans
 * 4,150 (done) to 13,174 (specify).
 *
 * It does NOT hold what `composeGuidanceEnvelope` adds after the handler returns:
 * the FOOTER_DELIMITER, the one-line dynamic state, the per-tool steer
 * (STEER_BY_TOOL), spec-249's status overview, spec-521 dec-5's supersession lead
 * line, and whatever the seat gains next.
 *
 * This constant stands in for exactly those, and [per std-50 cl-4] it errs in ONE
 * direction — it OVER-counts, so a response reserves more than the seat will
 * spend rather than less. The component it guesses about is named above, and the
 * direction does not vary with the phase, the tool or the Org.
 *
 * A CONSTRAINT, not a measurement [per std-50 cl-8]: the seat's additions are
 * bounded by this number, and the per-phase drift test is what enforces it.
 */
export const ENVELOPE_SEAT_ALLOWANCE_CHARS = 3_000;

/**
 * What this server DECLARES to its MCP clients as the largest result they should
 * accept before spilling it to a file — spec-538 dec-9, option (c).
 *
 * ## Why a declaration at all
 *
 * The spill threshold belongs to the client, and this server cannot interrogate
 * it. [per std-50 cl-2] a value a consumer cannot read is one its owner declares,
 * and [per std-50 cl-3] substituting a default for an absent declaration is the
 * behaviour that fails. The original `MEASURED_CAP_BOUND_CHARS = 70,794` (retired in t-12) was
 * exactly that substituted default — inferred from the smallest refusal ever
 * observed, and 41.6% above the client's real hardcoded 50,000 (issue-4).
 * Declaring replaces a guess ABOUT the client with a statement TO it.
 *
 * Advertised in each tool's `_meta` as `anthropic/maxResultSizeChars`. Verified
 * against the client (`2.1.260`): with `_meta` present the effective ceiling is
 * `Math.min(declared, 500_000)` and the hardcoded default no longer applies.
 *
 * ## Why 70,000 and not 500,000
 *
 * The maximum the client would honour is 500,000, and declaring it would be the
 * wrong move: the ceiling exists to protect the reading agent's CONTEXT WINDOW,
 * which is the interest this whole Spec serves. A payload that reaches the
 * context and floods it is not an improvement on one that reaches a file.
 *
 * 70,000 leaves a margin that the envelope's variance justifies. The worst case
 * a response can present is a full body budget alongside the largest envelope
 * ever measured — 40,000 + 23,244 = 63,244 — and 65,000 would have cleared that
 * by only 1,756 chars. At 70,000 the same worst case clears by 6,756, which is
 * what lets REQUIRED_CAP_MARGIN stay at 5,000 instead of being shaved to make an
 * assertion pass. [per std-50 cl-6] the reason is written here rather than left
 * to "it works"; [per cl-8] this is a CONSTRAINT the server states, not a
 * measurement of anything.
 *
 * ## This is a bridge, not a landmark
 *
 * The envelope it pays for is 94% static boilerplate — 13,930 of 14,815 chars
 * measured, re-sent on every call. When spec-510 turns that into a pointer after
 * first sight, the reserve falls to ~4,000 and this constant should come back
 * DOWN toward the client's own default. dec-9 sequences option (b) after this
 * one precisely so it can. Anyone finding this number later should be asking
 * whether spec-510 has landed, not raising it further.
 */
export const DECLARED_CLIENT_RESULT_CEILING_CHARS = 70_000;

/**
 * The client's DEFAULT spill threshold, READ from the client rather than inferred
 * from its behaviour — spec-538 t-12, correcting issue-4.
 *
 * This constant was `MEASURED_CAP_BOUND_CHARS = 70_794`, documented as "the
 * smallest response it was observed to refuse". That method cannot work: a
 * refusal sample bounds refusals from ABOVE and never reaches the threshold
 * [per std-50 cl-8 — a measurement of the present can falsify a reserve but
 * never confirm it]. The real value, read from the client (`2.1.260`), is
 * `eG = 50_000`, and 70,794 was 41.6% too high. A response of 53,247 chars was
 * refused while every bound derived from 70,794 said it would arrive.
 *
 * It is kept — under a name that describes what it IS — because it is what
 * applies if the `_meta` declaration below is ever dropped. It is NOT the
 * operative ceiling: DECLARED_CLIENT_RESULT_CEILING_CHARS is.
 */
export const CLIENT_DEFAULT_CEILING_CHARS = 50_000;

/**
 * The largest response BODY observed to arrive intact. The floor ac-26 puts
 * under the body budget: at or below this, a read that works today would start
 * being excerpted.
 */
export const LARGEST_WORKING_BODY_CHARS = 33_501;

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

/**
 * The document's own scaffolding, reserved before anything negotiable.
 *
 * Title, ref, type, status, checkout, URL, the tier declaration, the block
 * headers, the blank lines between them. None of it is content and none of it
 * can be dropped, but the first version budgeted only signals, envelope and
 * prose — so the shares summed to the budget and the render came out 152–557
 * chars over it. Small, and still a bound that did not hold.
 */
export const STRUCTURAL_RESERVE_CHARS = 2_400;

/** Per-section marker line, emitted at every tier. */
export const SECTION_MARKER_CHARS = 200;

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
   * What the tasks block would cost rendered in full (spec-538 dec-8).
   *
   * This region was missing from the first version, and it was the largest
   * unbudgeted one: 33,689 chars on spec-538 against 14,347 for its bounded
   * decisions. The Spec that defines the bound could not load itself.
   */
  tasksFullChars?: number;
  /** How many tasks that cost is spread across. */
  taskCount?: number;
  /**
   * How many sections the doc has — used to reserve the per-section marker
   * lines (`Section #N | ref: … | Type: … | Updated: …`) the render emits
   * whatever the tier.
   */
  sectionCount?: number;
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
   * What the WHOLE tasks block may occupy. `Infinity` renders as before.
   *
   * The block's total is passed rather than a per-task figure, because a
   * per-task figure cannot be multiplied back safely: below MIN_EXCERPT_CHARS
   * it is floored to 0, and `budget * count` then reads as "no budget", which
   * `effectiveBudget` treats as "unspecified" and answers with the full
   * constant. The block owns its own division.
   */
  tasksBudgetChars: number;
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

  // 1. Signals, the envelope and the document's own scaffolding are fixed costs.
  const fixed =
    input.signalsChars +
    input.envelopeChars +
    STRUCTURAL_RESERVE_CHARS +
    SECTION_MARKER_CHARS * (input.sectionCount ?? 0);
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
      tasksBudgetChars: 0,
      renderProseBodies: false,
      remainingAfterFixed,
    };
  }

  // Tier 1: everything fits at full size. Nine Specs in ten are here and their
  // output must not change shape.
  //
  // TASKS ARE PART OF "everything" (dec-8). The first version compared only the
  // decisions block, so a Spec whose tasks blew the budget was still declared
  // tier 1 or 2 — it announced a bound it did not hold, which is the defect
  // ac-6 exists to clean up elsewhere in this Spec.
  const tasksFull = input.tasksFullChars ?? 0;
  if (input.decisionsFullChars + tasksFull <= remainingAfterProse) {
    return {
      budget,
      tier: 1,
      perDecisionChars: Number.POSITIVE_INFINITY,
      tasksBudgetChars: Number.POSITIVE_INFINITY,
      renderProseBodies: true,
      remainingAfterFixed,
    };
  }

  // Tier 2: tight. What is left is shared between the two item blocks in
  // proportion to how much each would have cost — a Spec that is mostly tasks
  // spends most of its remainder on tasks, and vice versa. Splitting evenly
  // would starve whichever block carries the substance.
  const totalItemWeight = input.decisionsFullChars + tasksFull;
  const decisionShare =
    totalItemWeight > 0
      ? Math.floor((remainingAfterProse * input.decisionsFullChars) / totalItemWeight)
      : remainingAfterProse;
  const taskShare = remainingAfterProse - decisionShare;

  const derived =
    input.decisionCount > 0 ? Math.floor(decisionShare / input.decisionCount) : 0;

  return {
    budget,
    tier: 2,
    // Below the floor an excerpt is a fragment nobody can act on; fall to
    // headline + ref rather than emit noise that still costs bytes.
    perDecisionChars: derived >= MIN_EXCERPT_CHARS ? derived : 0,
    tasksBudgetChars: taskShare,
    renderProseBodies: true,
    remainingAfterFixed,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// Lists — spec-538 dec-5 (ac-20, ac-21)
// ══════════════════════════════════════════════════════════════════════════
//
// The rule is "does this output grow without a bound", and there are TWO axes.
// The first resolution of dec-5 saw only one: it concluded that a formatter
// rendering one line per item is safe, from `list_acs` at 27 items and
// `list_issues` at 5. Then `list_docs` was measured on its DEFAULT path —
// 467 documents × 187 chars = 88,494, refused by the client and spilled to a
// file, on the highest-traffic read of the whole surface (5,041 calls / 30d).
//
// One line per item is not a bound. It is a coefficient. Item COUNT grows just
// as unboundedly as body length, and it is the axis that was already failing.

export interface BoundedList {
  /** The entries that fit, in order. */
  kept: string[];
  /** How many were dropped. Zero means the output is untouched. */
  omitted: number;
}

/**
 * Keep whole entries until the budget runs out.
 *
 * Entries are never cut mid-way — the same rule dec-4 applies to section bodies,
 * for the same reason: a half-rendered item read as a whole one is worse than an
 * item that is honestly absent.
 *
 * `reservedChars` is what the caller will spend around the list — its header, and
 * the marker it must print when anything is dropped. Reserving the marker up
 * front is what stops the marker itself pushing the response over the line it
 * exists to announce.
 *
 * A list that fits comes back untouched with `omitted: 0`, so a caller can emit
 * exactly what it emits today (ac-26).
 */
export function boundRenderedList(
  entries: string[],
  opts: { budgetChars?: number; reservedChars?: number } = {},
): BoundedList {
  const budget = effectiveBudget(opts.budgetChars);
  const available = budget - (opts.reservedChars ?? 0);

  let spent = 0;
  const kept: string[] = [];
  for (const entry of entries) {
    const cost = entry.length + 1; // the newline that joins it
    if (spent + cost > available) break;
    spent += cost;
    kept.push(entry);
  }

  return { kept, omitted: entries.length - kept.length };
}
