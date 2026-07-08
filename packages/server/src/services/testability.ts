// spec-151 dec-5 / dec-6 — the clause TESTABILITY verdict: validation + deterministic
// persistence, kept in a request-path-SAFE module. add_clause / edit_clause import this
// to persist an agent-supplied verdict; they must NEVER import the LLM classifier engine
// (services/testability-classifier.ts), which the no-request-path guard
// (testability-classifier-no-request-path.regression.test.ts) enforces — exactly the
// posture facet-vocab.ts holds vs facet-classifier.ts (spec-340 dec-8 / std-30).
//
// The persisted verdict is ONE row's worth of columns on standard_clauses
// (is_obligation / testable / archetype), not a join table — testability is a single
// verdict per clause (std-32). `confidence` is never persisted (dec-5).

import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { standardClauses } from "../db/schema.js";
import { ValidationError } from "../types/errors.js";
import { mutate, type RequestCtx } from "./mutate.js";

// The seven testability archetypes, ranked (strongest universality first) — spec-151 s-6.
// `null` archetype = "not a universal test of a single kind" (only valid when not testable).
export const TESTABILITY_ARCHETYPES = [
  "type-constraint",
  "static-scan",
  "grep-denylist",
  "schema-introspection",
  "config-parity",
  "registry-completeness",
  "runtime-property",
] as const;

export type TestabilityArchetype = (typeof TESTABILITY_ARCHETYPES)[number];

/**
 * A clause's testability verdict as it is persisted (dec-5). `confidence` and the free-text
 * `how` the classifier also emits are intentionally absent — they have no production reader.
 */
export interface TestabilityVerdict {
  isObligation: boolean;
  testable: boolean;
  /** One of TESTABILITY_ARCHETYPES, or null when the clause is not testable. */
  archetype: TestabilityArchetype | null;
}

const ARCHETYPE_SET = new Set<string>(TESTABILITY_ARCHETYPES);

/**
 * Validate + normalize an agent-supplied testability verdict. Throws ValidationError on a
 * malformed shape so a bad verdict never lands a half-classified clause. Normalizes the
 * dependent invariant: a non-testable clause carries no archetype (archetype is forced to
 * null), and a testable clause MUST name a known archetype.
 */
export function validateTestabilityVerdict(input: {
  isObligation: unknown;
  testable: unknown;
  archetype?: unknown;
}): TestabilityVerdict {
  if (typeof input.isObligation !== "boolean") {
    throw new ValidationError("testability.isObligation must be a boolean.");
  }
  if (typeof input.testable !== "boolean") {
    throw new ValidationError("testability.testable must be a boolean.");
  }
  if (!input.testable) {
    // A non-testable clause has no universal-test archetype, whatever was passed.
    return { isObligation: input.isObligation, testable: false, archetype: null };
  }
  if (typeof input.archetype !== "string" || !ARCHETYPE_SET.has(input.archetype)) {
    throw new ValidationError(
      `testability.archetype must be one of ${TESTABILITY_ARCHETYPES.join(", ")} when testable is true.`,
    );
  }
  return {
    isObligation: input.isObligation,
    testable: true,
    archetype: input.archetype as TestabilityArchetype,
  };
}

/**
 * Persist a clause's testability verdict onto its standard_clauses row (deterministic, no
 * LLM). Routed through mutate() emitting `clause` updated so the standard's clause-coverage
 * view refetches — the same bus contract persistClauseFacets uses (std-8).
 */
export async function persistClauseTestability(
  memexId: string,
  docId: string,
  clauseId: string,
  verdict: TestabilityVerdict,
  ctx: RequestCtx = {},
): Promise<void> {
  await mutate(ctx, { memexId, docId, entity: "clause", action: "updated" }, async () => {
    await db
      .update(standardClauses)
      .set({
        isObligation: verdict.isObligation,
        testable: verdict.testable,
        archetype: verdict.archetype,
        updatedAt: new Date(),
      })
      .where(eq(standardClauses.id, clauseId));
    return { id: clauseId };
  });
}

/**
 * The clause-coverage denominator predicate (dec-5 / ac-16): a clause counts toward a
 * standard's coverage % ONLY when it is a testable obligation. A non-obligation
 * (rationale / vocabulary / scope) or an untestable obligation is excluded — the honest
 * denominator is obligations that CAN carry a universal test. Unclassified clauses
 * (NULL verdict) are not yet countable.
 */
export function isCoverageCountable(clause: {
  isObligation: boolean | null;
  testable: boolean | null;
}): boolean {
  return clause.isObligation === true && clause.testable === true;
}
