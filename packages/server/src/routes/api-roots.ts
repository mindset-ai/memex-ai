// spec-515 — the `/api` root vocabulary: which top-level words are NOT tenant
// namespaces.
//
// This module has **zero imports on purpose**. Three very different places need the
// same answer, and none of them should drag the others in:
//
//   middleware/memex-resolver.ts  — must a path be parsed as `<namespace>/<memex>`?
//   services/shared/slug.ts       — may a user claim this word as a namespace slug?
//   routes/flat-api-mounts.ts     — is this root declared, so the mount may proceed?
//
// `slug.ts` importing the resolver would pull `db/connection` into slug validation;
// the resolver importing `slug.ts` would be a cycle. A dependency-free declaration
// is what lets both read one definition instead of keeping two in step by hand.
//
// std-3 cl-7 (amended 2026-07-28) states the rule this file implements: the
// reserved-slug list is the UNION of the app/marketing words and the API roots, and
// the coupling is required in both directions — a word that is both an API root and
// a namespace slug makes one of the two unreachable.

// MEASURED IMPACT — and ⚠ CORRECTED 2026-08-28 (spec-520 issue-2), because the original
// wording attributed a cost to this fix that this fix does not remove, in the direction
// that stops someone looking further.
//
// The observation was real: `pg_stat_statements` showed **~11.6M INSERT/DELETE/upsert
// calls** across the test_events emission path, about **31% of prod Cloud SQL CPU** on a
// 1-vCPU instance. Reserving `test-events` makes /batch reachable, and that IS a real fix.
//
// WHAT IT FIXED: the REQUEST count. Before, the emitter's batch POST 404'd and it fell back
// to one POST per test — so a suite tagging 500 criteria opened 500 requests, each taking a
// DB-pool slot. Restoring /batch collapses that to roughly one request per test FILE, and
// amortises the ONE statement that is per-request: the emission-key verify.
//
// WHAT IT DID NOT FIX: the per-EVENT statement cost, which is most of that 31%. The batch
// route authenticates once and then loops `processOneEvent` per event, so six of the seven
// statements run exactly as often as before. Restoring the route removed approximately none
// of them.
//
// Measured on prod as a 600s delta, 2026-08-28 (spec-520 c-9) — the batching is visible in
// exactly one row and absent from the rest:
//
//   30.973 calls/s  INSERT test_events          <- per EVENT
//   30.973 calls/s  DELETE test_events (trim)   <- per EVENT
//   30.973 calls/s  INSERT test_run_daily       <- per EVENT
//   30.972 calls/s  INSERT ac_first_verified    <- per EVENT
//   30.972 calls/s  UPDATE memex_emission_keys  <- per EVENT
//    3.947 calls/s  SELECT memex_emission_keys  <- per BATCH: ~1 auth per 8 events
//
// So: spec-515 fixed request amplification; spec-520 is the Spec that attacks the write
// amplification, and its t-6 / t-12 / dec-7 work is what actually removes those rows. Do not
// read this paragraph as "the 31% was solved here".

/**
 * Every top-level segment under which a NON-TENANT router is mounted flat at
 * `/api/<root>`. Declaring a root here is what permits `mountFlatApi` to mount it
 * (see `flat-api-mounts.ts`) AND what exempts it from tenant parsing AND what makes
 * it unclaimable as a namespace slug. One edit, three consequences.
 *
 * Roots reserved for other shapes live in {@link NON_FLAT_RESERVED_ROOTS}.
 */
export const FLAT_API_MOUNT_ROOTS: ReadonlySet<string> = new Set([
  "acs",
  "auth",
  "backstage",
  "comments",
  "consent",
  "decisions",
  "docs",
  "drift",
  "email",
  "execution-plans",
  "hook-keys",
  "internal",
  "invites",
  "issues",
  "live",
  "llm",
  "me",
  "namespaces",
  "oauth",
  "orgs",
  "redirects",
  "share",
  "spec-checkout",
  "tasks",
  "telemetry",
  "test-events",
  "waitlist",
  "whats-new",
]);

/**
 * Roots reserved for shapes `mountFlatApi` cannot record, each declared by hand WITH
 * its reason. Keeping these separate from the flat mounts is the point: the
 * hand-maintained half stays small enough that a reviewer can audit every entry.
 */
export const NON_FLAT_RESERVED_ROOTS: ReadonlySet<string> = new Set([
  // Direct handler, not a router mount: app.get("/api/health").
  "health",
  // Deep mounts — the root carries no router of its own, but `/api/<root>/<sub>` is
  // two segments after /api, so the resolver would read <root> as a namespace.
  "cli", //      /api/cli/auth
  "mcp", //      /api/mcp/tokens  (+ app.all("/mcp"), outside /api entirely)
  "stripe", //   /api/stripe/webhook — the Stripe-Signature HMAC is the auth (spec-171)
  "postmark", // /api/postmark/webhook — a Basic-auth credential is the auth (spec-341)
  // Env-gated test surface, mounted conditionally. The slug grammar rejects
  // underscores anyway, so this entry is belt-and-braces.
  "__test__",
  // spec-515 dec-7 found these two apparently stale and deliberately KEPT them:
  // `onboarding` has no mount in app.ts at all, and `team` is only mounted
  // tenant-prefixed (/api/:namespace/:memex/team), so neither needs an exemption
  // today. An extra entry only reserves a word; removing them is a slug-availability
  // change that does not belong in a routing fix.
  "onboarding",
  "team",
]);

/**
 * The effective set of `/api` roots that are not tenant namespaces.
 *
 * A function rather than a const so every consumer — `parseMemexPath`, the
 * reserved-slug list, the deploy-precondition collision check (spec-515 t-3) and the
 * guard tests — resolves the same definition at call time. No consumer can hold a
 * stale copy, which is the failure this Spec exists to close.
 */
export function reservedApiRoots(): ReadonlySet<string> {
  return new Set([...NON_FLAT_RESERVED_ROOTS, ...FLAT_API_MOUNT_ROOTS]);
}

/**
 * The response header the tenant resolver stamps on a request it EXEMPTS from
 * tenant parsing (spec-515 dec-6), asserted for every reserved root by the
 * post-deploy smoke check (`__smoke__/flat-api-reachability.smoke.test.ts`).
 *
 * It lives HERE, in the zero-import module, for the same reason the root
 * declaration does. It first lived in `middleware/memex-resolver.ts`, so a smoke
 * check that needed nothing but the header NAME had to import the resolver —
 * which imports `db/connection` and therefore demands DATABASE_URL at module
 * load. Both spec-515 smoke files died on import against a live int deploy,
 * before their own skip guards could run, for want of a string constant. The
 * resolver re-exports it, so existing importers are unaffected.
 */
export const TENANT_EXEMPT_HEADER = "x-memex-tenant";
