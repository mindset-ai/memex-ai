// PROD FOOTER BASELINE — captured live from https://memex.ai/mcp on 2026-06-10,
// against a throwaway spec in wic/personal, BEFORE the sole-author relocation.
//
// Purpose: the sole-author relocation (handler-authored guidance moved into
// composeGuidanceEnvelope, past the FOOTER_DELIMITER) must be a NET IMPROVEMENT
// over prod, which means two things together:
//   1. Centralized: none of these strings appears BEFORE the delimiter anymore
//      (enforced by guidance-sole-author.integration.test.ts).
//   2. Nothing dropped: each of these strings STILL appears in the tool's
//      response, now in the footer (after the delimiter). The faithfulness test
//      asserts the stable substrings below survive on the AFTER side.
//
// Each entry records the tool, where prod emits the guidance (all BEFORE the
// delimiter = handler-authored, except create_doc which has no delimiter at all
// because it resolves no target), the stable substring a test can assert, and
// the full captured text for the record.

export interface ProdGuidanceBaseline {
  tool: string;
  /** Where prod emits it today. "result" = before the delimiter (handler), or
   *  "no-footer" for create_doc (resolves no target, so no envelope at all). */
  prodPosition: "result-before-delimiter" | "no-footer";
  /** Stable phrase(s) that must survive the relocation (counts/ids stripped). */
  stableSubstrings: string[];
  /** Verbatim capture, for the record. */
  captured: string;
  /** Relocation status in the local worktree at capture time. */
  relocated: boolean;
}

export const PROD_FOOTER_BASELINE: ProdGuidanceBaseline[] = [
  {
    tool: "create_doc",
    prodPosition: "no-footer",
    stableSubstrings: ["Next: author Scope ACs for this Spec"],
    captured:
      "Next: author Scope ACs for this Spec. Scope ACs are plain-English outcome " +
      "commitments that define what success looks like — they ground every " +
      "downstream Decision. Walk the user through 3–5 of them now via:\n" +
      '  create_ac({ ref: "<spec>", kind: "scope", statement: "..." })\n' +
      "Don't skip this in draft/specify. See get_information(topic='phases') for " +
      "the full phase mechanics.",
    relocated: false,
  },
  {
    tool: "resolve_decision",
    prodPosition: "result-before-delimiter",
    stableSubstrings: [
      // spec-219 comb-through: resolve_decision was de-jargoned BEYOND the prod
      // copy (enhancement, not faithful relocation), so these pin the ENHANCED
      // copy, not the prod verbatim recorded in `captured` below.
      "Next: create the implementation acceptance criteria this decision will be verified by",
      "the spec can't move into build",
    ],
    captured:
      "Next: author the implementation AC(s) this decision will be verified by — " +
      "`create_ac({ ref: '<this-spec>', kind: 'implementation', parent_decision_ref: " +
      "'<dec>', statement: '...' })`. One decision typically spawns 2-5 implementation " +
      "ACs (one per distinct behavioural claim). See `get_information(topic='decisions-" +
      "need-acs')` for the full discipline. Without these, build-readiness will refuse " +
      "the specify→build move.",
    relocated: true,
  },
  {
    tool: "update_doc",
    prodPosition: "result-before-delimiter",
    // THREE distinct handler-authored pieces — the capture surfaced the
    // "Outstanding work" readiness section that the catalogue had missed.
    stableSubstrings: [
      "Tip: run assess_spec({mode:'phase'})",
      "Outstanding work:",
      "Build is where tagged tests get written",
    ],
    captured:
      "ℹ Tip: run assess_spec({mode:'phase'}) before transitioning forward — it " +
      "surfaces open decisions, incomplete work, and drift you might miss.\n\n" +
      "Outstanding work:\n- <N> decision(s) not yet reflected in the narrative — Use " +
      'the "Update spec narrative" helper to consolidate.\n\n' +
      "AC coverage: <p>% (<c>/<t> active ACs have ≥1 tagged test; <u> untested). Build " +
      "is where tagged tests get written — every active AC should have at least one " +
      "tagged test before verify, not just the ones you happen to implement this turn. " +
      "See get_information(topic='test-coverage').",
    relocated: false,
  },
  {
    tool: "update_task",
    prodPosition: "result-before-delimiter",
    stableSubstrings: [
      // spec-219 comb-through: COMPLETION_NUDGE de-jargoned BEYOND the prod copy
      // (enhancement), so this pins the ENHANCED wording, not the prod verbatim
      // in `captured` below.
      "comment for whoever picks this up next",
    ],
    captured:
      "Before moving on, leave a `progress` comment using the standard handoff " +
      "schema (What landed / Contract / Surprises / For downstream).",
    relocated: true,
  },
];

/** Tools confirmed CLEAN at capture (no handler-authored guidance before the
 *  delimiter; all guidance is composeGuidanceEnvelope's phase essence/header):
 *  create_ac, create_decision, create_task, add_section, get_doc. */
export const PROD_CLEAN_TOOLS = [
  "create_ac",
  "create_decision",
  "create_task",
  "add_section",
  "get_doc",
] as const;
