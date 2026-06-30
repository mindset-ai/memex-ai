// spec-151 dec-7 — the request-path-SAFE side of clause-test verification: recording a
// verdict and reading the confirmed set. Deterministic, NO LLM — so the clause-coverage
// read (reachable from routes/standards.ts) can consult verification WITHOUT importing
// the LLM verifier engine (services/clause-test-verifier.ts), exactly as facet-vocab.ts
// stays clean of facet-classifier.ts (spec-340 dec-8). A no-request-path guard bans the
// engine module from request-path dirs.

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { clauseTestVerifications } from "../db/schema.js";

/** Record a verifier verdict (deterministic). Latest verdict per (ref, test) wins. */
export async function recordClauseTestVerification(input: {
  memexId: string;
  subjectRef: string;
  testIdentifier: string | null;
  verdict: "confirmed" | "rejected";
  verifier?: string;
  reason?: string;
}): Promise<void> {
  const testId = input.testIdentifier ?? "";
  await db
    .insert(clauseTestVerifications)
    .values({
      subjectRef: input.subjectRef,
      testIdentifier: testId,
      verdict: input.verdict,
      verifier: input.verifier ?? null,
      reason: input.reason ?? null,
      memexId: input.memexId,
    })
    .onConflictDoUpdate({
      target: [clauseTestVerifications.subjectRef, clauseTestVerifications.testIdentifier],
      set: {
        verdict: input.verdict,
        verifier: input.verifier ?? null,
        reason: input.reason ?? null,
        createdAt: new Date(),
      },
    });
}

/**
 * Map of clause ref → set of CONFIRMED test_identifiers (stored form: '' for the null
 * test id). The clause-coverage read consults this to gate state on verification: a
 * clause with tests but no confirmed verdict is "pending" (ac-20).
 */
export async function confirmedTestsForRefs(
  refs: string[],
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (refs.length === 0) return out;
  const rows = await db
    .select({
      subjectRef: clauseTestVerifications.subjectRef,
      testIdentifier: clauseTestVerifications.testIdentifier,
    })
    .from(clauseTestVerifications)
    .where(
      and(
        inArray(clauseTestVerifications.subjectRef, refs),
        eq(clauseTestVerifications.verdict, "confirmed"),
      ),
    );
  for (const r of rows) {
    const set = out.get(r.subjectRef) ?? new Set<string>();
    set.add(r.testIdentifier);
    out.set(r.subjectRef, set);
  }
  return out;
}
