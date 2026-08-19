// Default Standards — seed + backfill (spec-184 t-2 / t-3 / t-4).
//
// Seeds every new PERSONAL Memex with the six portable best-practice Standards
// (spec-184) so a new user lands with a non-empty Standards list that shows how we
// work with Memex, models what a good Standard looks like, and gets applied while they
// work their first Spec. The canonical content lives ONCE in
// db/default-standards.fixture.ts; this module maps it through the existing clause-first
// standard primitives (createDocDraft → addSectionWithClauses — each already
// wraps mutate() + emits on the unified bus, std-8).
//
// dec-3: defaults are ORDINARY editable/deletable standard rows — NO is_demo/is_default
// marker, NO reset. Idempotency therefore keys off "the Memex already has ≥1 standard"
// (the zero-Standards guard), which is shared by the signup seed and the deploy backfill
// and which also implements dec-4's "backfill empty Standards lists only" scope: because
// there is no marker, we can't tell our seeded Standards from a user's own, so a Memex
// with ANY standard is left untouched.
//
// Mirrors services/handhold-demo.ts (the spec-178 sibling), minus the marker/reset/
// self-heal machinery that an is_demo flag would afford — see dec-3.

import { and, eq } from "drizzle-orm";
import { db, runWithMemexId } from "../db/connection.js";
import { documents, namespaces, memexes } from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import { addSectionWithClauses } from "./clauses.js";
import { DEFAULT_STANDARDS } from "../db/default-standards.fixture.js";

const STANDARD_DOC_TYPE = "standard";

// Count this Memex's standard documents (any status). The seed/backfill guard: a Memex
// with ANY standard is left untouched (dec-3 no marker → we can't distinguish ours from
// the user's; dec-4 scopes seeding to empty Standards lists only).
async function countStandards(memexId: string): Promise<number> {
  const rows = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.memexId, memexId), eq(documents.docType, STANDARD_DOC_TYPE)));
  return rows.length;
}

/**
 * Idempotently seed the six default Standards into `memexId`.
 *
 * NO-OP when the Memex already has any standard (the zero-Standards guard) — so signup
 * retries, the deploy backfill, and repeated calls are all safe, and a user-authored
 * Standard is never overwritten (dec-3 / dec-4 empty-list scope). Each default is built
 * clause-first (createDocDraft is born sectionless for standards per spec-161; each
 * section's content is the ordered join of its clauses) so the seeded rows render with
 * cl-N exactly like an authored Standard — the form we're teaching by example.
 *
 * Best-effort + LOCK-FREE by design (the same pattern the spec-178 handhold seeder runs in
 * production). The guard is a read-then-write, so a TRUE concurrent double-fire on the SAME
 * Memex — a signup landing in the ~few-ms window of the deploy backfill processing that
 * exact Memex — could in principle both pass the guard and double-seed.
 *
 * ⚠️ Do NOT "fix" that with a held advisory lock. We tried (spec-184 review): holding one
 * DB connection across the seed's clause-first writes — each of which grabs its OWN pool
 * connection — starves the small connection pool under signup load and deadlocks the server
 * test suite. The race is extremely rare (spec-177's signup concurrency handling already
 * collapses the double-submit case to a single seed, leaving only signup×backfill on the
 * same Memex in a tiny window, once per deploy) and partly self-limiting (two racing seeds
 * tend to collide on the minted std-N handle, and the loser is swallowed by the best-effort
 * caller). Worst case: a user sees a duplicate Standard they can delete. If it ever needs
 * hardening, the pool-safe fix is a partial unique index on
 * (memex_id, lower(title)) WHERE doc_type='standard' — a DB constraint, NOT a held lock.
 *
 * Partial-seed note: not self-healing (no marker, dec-3). A crash mid-loop leaves a partial
 * set the guard then treats as seeded — whole Standards missing, which is dec-3's accepted
 * simplicity cost. It no longer leaves a section rendering from pre-seeded content: since
 * spec-514 dec-1 a section and its clauses are created by one service call that validates
 * first, so the crash window this used to paper over is gone.
 */
export async function seedDefaultStandards(memexId: string): Promise<void> {
  if ((await countStandards(memexId)) > 0) return;

  for (const std of DEFAULT_STANDARDS) {
    // spec-161: a standard is born sectionless — the `purpose` arg is ignored for the
    // 'standard' docType, so content arrives entirely as clauses below. addSectionWithClauses
    // preserves the posture this seeder depends on: each underlying primitive still opens
    // its OWN short mutate()-wrapped transaction on the pool (std-8 bus emission intact)
    // and releases the connection between calls — so concurrent detached seeds never
    // accumulate HELD connections (the pool-starvation failure mode above). That is
    // exactly why spec-514 dec-1 ordered the two calls rather than merging them into one
    // transaction.
    const created = await createDocDraft(memexId, std.title, "", STANDARD_DOC_TYPE);
    for (const section of std.sections) {
      // spec-437 dec-1: each default clause carries a deliberate facet verdict — the
      // section's parallel `facets` array, or [] ("governs nothing") where it sets none
      // (methodology / description / rationale / scope clauses). Persisted against the
      // facet vocabulary seeded first (see seedNewPersonalMemex).
      //
      // spec-514 dec-1: one call, which validates the whole batch before the section row
      // exists. This used to pre-seed the section's content to the clause join as a guard
      // against crashing between the two primitives — a workaround written at THIS call
      // site, which is precisely why the agent-facing add_section handler never inherited
      // the protection and shipped the orphaned-section bug. The guarantee lives in the
      // service now, so the workaround is not just redundant but misleading.
      await addSectionWithClauses(
        memexId,
        created.id,
        section.sectionType,
        section.clauses.map((body, i) => ({ body, facets: section.facets?.[i] ?? [] })),
        section.title,
      );
    }
  }
}

/**
 * Backfill: seed the defaults into every PERSONAL Memex that has no Standards yet
 * (spec-184 t-4 / dec-4). Iterates personal namespaces (kind='user') joined to their
 * memexes and calls seedDefaultStandards on each — the per-Memex zero-Standards guard
 * makes re-runs (every CI/CD deploy) safe and cheap, skips any Memex a user has already
 * started curating, and never touches team/org Memexes. Returns the count of Memexes
 * seeded on THIS run (Memexes that already had Standards are skipped, not counted).
 */
export async function backfillDefaultStandards(): Promise<{ memexesSeeded: number }> {
  const personalMemexes = await db
    .select({ memexId: memexes.id })
    .from(memexes)
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(namespaces.kind, "user"));

  let memexesSeeded = 0;
  for (const { memexId } of personalMemexes) {
    // spec-440: run the per-memex read (countStandards) + seed (seedDefaultStandards →
    // documents/standard_clauses/clause_refs) inside the tenant context so they carry
    // app.memex_id and satisfy RLS under the runtime memex_app role. Deploy-wired
    // (deploy.sh); correct regardless of the connecting role with this wrapper.
    await runWithMemexId(memexId, async () => {
      const before = await countStandards(memexId);
      await seedDefaultStandards(memexId);
      // Count only Memexes that had ZERO Standards and therefore got the fresh seed.
      if (before === 0) memexesSeeded += 1;
    });
  }
  return { memexesSeeded };
}
