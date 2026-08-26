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
// NAMING, and it is load-bearing (dec-7, ac-28): the budget bounds the response
// BODY, not the whole response. The envelope is attached after the body is
// rendered and cannot be measured from inside it, so it is accounted for by how
// this number was chosen. A reader who budgets a whole response against it would
// be over by up to 23k — which is exactly the class of defect ac-6 exists to
// clean up elsewhere in this Spec.

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
 *   smallest read the client REFUSED  70,794            ← upper bound on the cap
 *
 * There is a clean gap: everything observed working is ≤ 47,561 in total,
 * everything observed failing is ≥ 70,794. Nothing lands between.
 *
 * LOWER BOUND — ac-26, no read that works today may change shape. The largest
 * body that currently arrives is 33,501, so anything at or below that would
 * reshape a response that works fine now. 40,000 clears it by 19%.
 *
 * UPPER BOUND — ac-27, body + worst-case envelope must stay under the cap.
 * 40,000 + 23,244 = 63,244, which is 7,550 under the smallest refusal observed.
 * Both bounds are asserted in the suite, not claimed here.
 *
 * The viable window is therefore roughly 33,501 … 42,550. Move within it freely;
 * leaving it reds a test.
 *
 * CAVEAT ON THE SAMPLE: 18 reads, from one developer's sessions, biased toward
 * the Specs that developer worked on. The margins above are what absorb that.
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
export const RESPONSE_BODY_BUDGET_CHARS = 40_000;

/**
 * The worst-case guidance envelope, measured by decomposing a real payload:
 * 11,228 phase guidance + 11,950 full handoff prompt + 66 activity. The largest
 * envelope observed independently in transcripts is 22,215, which corroborates
 * it from the other direction.
 *
 * This is NOT subtracted per response — dec-7 option (d): the body budget is
 * already net of it, and this constant exists so that fact is checkable rather
 * than asserted in prose.
 */
export const MEASURED_ENVELOPE_MAX_CHARS = 23_244;

/**
 * An upper bound on the MCP client's cap — the smallest response it was observed
 * to refuse. Not the cap: the real value is lower, belongs to the client, and is
 * user-configurable. Every budget here is a margin under this, never an equality.
 */
export const MEASURED_CAP_BOUND_CHARS = 70_794;

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
  if (typeof maxChars !== "number") return RESPONSE_BODY_BUDGET_CHARS;
  if (!Number.isFinite(maxChars) || maxChars <= 0) return RESPONSE_BODY_BUDGET_CHARS;
  return Math.min(maxChars, RESPONSE_BODY_BUDGET_CHARS);
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
