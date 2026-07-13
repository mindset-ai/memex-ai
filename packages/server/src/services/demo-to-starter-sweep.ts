// One-shot demo→starter sweep (spec-474 dec-3 / ac-15 / ac-16 / ac-17).
//
// The demo-vs-starter provisioning experiment concluded with the "Understanding
// Memex" starter Spec as the winner (spec-474 dec-1). The signup path now seeds the
// starter directly (user-namespaces.ts) — but that is NET-NEW only: it fires solely
// on personal-namespace CREATE, so every user created BEFORE the cutover is left in
// whatever state the experiment put them (frozen is_demo walkthrough docs, or nothing).
//
// This sweep is the backfill that reconciles those pre-cutover users to the winning
// arm, in one idempotent pass across EVERY personal Memex:
//   (a) TEAR DOWN every is_demo doc (the losing demo-walkthrough arm), and
//   (b) SEED the starter Spec into any personal Memex whose OWNER has not yet
//       authored their own real spec — leaving self-authored users (who are past
//       onboarding) and already-starter'd Memexes untouched.
//
// It reuses the exact iteration shape of the retired backfillHandholdDemo (personal
// namespaces → memexes, each run under runWithMemexId for RLS, std-36), reversed:
// it clears the demo instead of seeding it, and seeds the starter instead of skipping.
// Every teardown/seed goes through the existing service primitives
// (clearDemoDocsForMemex / seedStarterSpec) so the std-8 emissions + std-32 attribution
// contracts hold. A --dry-run mode reports what it WOULD do without any write.
//
// Bounded per std-39: it iterates memex-by-memex, each its own short transaction (the
// mutate()/seed internals), never one giant transaction; progress is logged every N.

import { and, eq, isNull } from "drizzle-orm";
import { db, runWithMemexId } from "../db/connection.js";
import { documents, namespaces, memexes } from "../db/schema.js";
import type { RequestCtx } from "./mutate.js";
import { clearDemoDocsForMemex } from "./demo-cleanup.js";
import { seedStarterSpec } from "./starter-spec.js";
import { STARTER_SPEC_TITLE } from "../db/starter-spec.fixture.js";

// The sweep writes on behalf of the system, not any user. `server` is the only
// RequestCtx channel that fits an operator-run backfill (the enum is
// rest_ui|mcp|in_app_agent|server — there is no `backfill` value), and a missing
// channel is a visible defect per std-32, so we set it explicitly.
const SWEEP_CTX: RequestCtx = { channel: "server" };

// Log a running progress line every N memexes so a long prod sweep is observable.
const PROGRESS_EVERY = 25;

export interface SweepPerMemex {
  memexId: string;
  /** is_demo docs found in the memex (deleted in live mode; would-delete in dry-run). */
  demoDocs: number;
  /** True if the OWNER authored their own real (is_demo=false) spec — the skip signal. */
  hadOwnSpec: boolean;
  /** True when a starter Spec was (or, in dry-run, WOULD BE) newly seeded here. */
  seeded: boolean;
}

export interface SweepResult {
  /** Total is_demo docs deleted (live) or that WOULD be deleted (dry-run). */
  demoDocsDeleted: number;
  /** Personal Memexes newly seeded (live) or that WOULD be seeded (dry-run). */
  memexesSeeded: number;
  /** Personal Memexes left untouched by the seed step (own spec, or already starter'd). */
  memexesSkipped: number;
  /** Per-memex breakdown, one row per personal Memex visited. */
  perMemex: SweepPerMemex[];
}

export interface SweepOpts {
  /** When true, compute + report only — perform NO writes. */
  dryRun: boolean;
  /**
   * Optional scope: restrict the sweep to these memex ids. Production runs omit it
   * (sweep every personal Memex); it exists so tests + targeted ops can operate on a
   * known subset of the shared DB without touching unrelated fixtures.
   */
  onlyMemexIds?: string[];
}

// True if this memex already carries the system-attributed starter spec. Mirrors
// starter-spec.ts:starterSpecExists exactly — the marker is (docType='spec',
// title=STARTER_SPEC_TITLE, createdByUserId IS NULL). Used to distinguish a NEW seed
// from a no-op so memexesSeeded counts only genuine additions.
async function hasSystemStarter(memexId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        eq(documents.memexId, memexId),
        eq(documents.docType, "spec"),
        eq(documents.title, STARTER_SPEC_TITLE),
        isNull(documents.createdByUserId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

// True if the OWNER authored their own real spec here: a documents row with
// docType='spec', createdByUserId = ownerUserId, is_demo=false. The system starter
// (createdByUserId IS NULL) can never match, so it never counts as a self-authored
// spec — exactly the hasSpec predicate the onboarding journey uses (journey-state.ts).
async function ownerHasOwnSpec(memexId: string, ownerUserId: string | null): Promise<boolean> {
  if (!ownerUserId) return false;
  const [row] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        eq(documents.memexId, memexId),
        eq(documents.docType, "spec"),
        eq(documents.createdByUserId, ownerUserId),
        eq(documents.isDemo, false),
      ),
    )
    .limit(1);
  return row !== undefined;
}

// Count the memex's is_demo docs (includes archived/paused — the sweep must see
// EVERY demo doc, mirroring demo-cleanup.listDemoDocIds).
async function countDemoDocs(memexId: string): Promise<number> {
  const rows = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.memexId, memexId), eq(documents.isDemo, true)));
  return rows.length;
}

/**
 * Sweep every personal Memex to the winning provisioning arm (spec-474 dec-3):
 * delete all is_demo docs, and seed the "Understanding Memex" starter Spec into any
 * personal Memex whose owner has NOT authored their own real spec.
 *
 * Idempotent + safe to re-run: a memex whose owner has an own spec is left alone, a
 * memex that already holds the starter is not re-seeded, and a demo-free memex has
 * nothing to delete. In dry-run mode NO writes happen — the returned counts are
 * exactly what a subsequent live run then performs.
 */
export async function sweepDemoToStarter(opts: SweepOpts): Promise<SweepResult> {
  const { dryRun } = opts;
  const scope = opts.onlyMemexIds ? new Set(opts.onlyMemexIds) : null;

  // Every personal Memex + its owning user — the same personal-namespace iteration
  // the retired backfill used (memexes ⋈ namespaces WHERE kind='user'). Cross-tenant
  // read on the owner connection (RLS is ENABLE, not FORCE — std-36), so it is NOT
  // wrapped in runWithMemexId; only the per-memex work below is.
  const personal = await db
    .select({ memexId: memexes.id, ownerUserId: namespaces.ownerUserId })
    .from(memexes)
    .innerJoin(namespaces, eq(namespaces.id, memexes.namespaceId))
    .where(eq(namespaces.kind, "user"));

  const targets = scope ? personal.filter((p) => scope.has(p.memexId)) : personal;

  const result: SweepResult = {
    demoDocsDeleted: 0,
    memexesSeeded: 0,
    memexesSkipped: 0,
    perMemex: [],
  };

  let visited = 0;
  for (const { memexId, ownerUserId } of targets) {
    await runWithMemexId(memexId, async () => {
      // 1. What demo docs are present (report + would/actually delete count).
      const demoDocs = await countDemoDocs(memexId);

      // 2. Has the owner authored their own real spec? (the skip signal)
      const hadOwnSpec = await ownerHasOwnSpec(memexId, ownerUserId);

      // 3. Would a NEW starter be seeded? Seed IFF the owner has no own spec AND a
      //    system starter isn't already present. (seedStarterSpec is itself
      //    idempotent; this pre-check is only so we count NEW seeds accurately.)
      const starterAlready = await hasSystemStarter(memexId);
      const willSeed = !hadOwnSpec && !starterAlready;

      if (!dryRun) {
        // LIVE: tear down demo docs first, then conditionally seed the starter.
        if (demoDocs > 0) {
          await clearDemoDocsForMemex(memexId, SWEEP_CTX);
        }
        if (willSeed) {
          await seedStarterSpec(memexId, SWEEP_CTX);
        }
      }

      // Accumulate totals identically for dry-run + live (dry-run = the would-do plan).
      result.demoDocsDeleted += demoDocs;
      if (willSeed) result.memexesSeeded += 1;
      else result.memexesSkipped += 1;

      result.perMemex.push({ memexId, demoDocs, hadOwnSpec, seeded: willSeed });
    });

    visited += 1;
    if (visited % PROGRESS_EVERY === 0) {
      console.log(
        `[demo→starter sweep${dryRun ? " (dry-run)" : ""}] ${visited}/${targets.length} personal memexes processed ` +
          `— ${result.demoDocsDeleted} demo doc(s), ${result.memexesSeeded} seeded, ${result.memexesSkipped} skipped so far`,
      );
    }
  }

  return result;
}
