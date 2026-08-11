// spec-515 t-3 / ac-7 — deploy PRE-condition: no namespace slug may squat a
// reserved API root.
//
// Usage (wired into packages/server/deploy.sh, before migrations):
//   DATABASE_URL="..." pnpm --filter @memex/server tsx scripts/check-reserved-root-collisions.ts
//
// GATING, unlike the backfill scripts that run post-cutover with `|| echo`. A
// collision means a live tenant is about to become unroutable, which is not
// something to discover from a support ticket. Exit codes:
//
//   0 — no collision, safe to proceed
//   1 — collision found; the deploy MUST NOT proceed
//   2 — the check itself could not run (no DATABASE_URL, DB unreachable)
//
// Exit 2 is deliberately distinct from exit 1 and is ALSO fail-closed at the call
// site: "the check broke" must never be read as "the check passed". That
// distinction is the whole reason this isn't a `|| true` step.
//
// Read-only: it runs before migrations against a live database and issues nothing
// but SELECTs.

import {
  findReservedRootSlugCollisions,
  formatCollisions,
} from "../src/services/reserved-root-collisions.js";

async function main(): Promise<number> {
  if (!process.env.DATABASE_URL) {
    console.error(
      "[reserved-root-check] DATABASE_URL is not set — cannot verify. Refusing to report success.",
    );
    return 2;
  }

  const collisions = await findReservedRootSlugCollisions();

  if (collisions.length === 0) {
    console.log(
      "[reserved-root-check] ✓ no namespace slug or post-rename reservation collides with a reserved API root.",
    );
    return 0;
  }

  console.error(
    `[reserved-root-check] ✗ ${collisions.length} collision(s) — the deploy will NOT proceed:\n` +
      `${formatCollisions(collisions)}\n\n` +
      "Reserving one of these roots makes the tenant that owns it unroutable\n" +
      "(memexResolver stops resolving the word, per std-3 cl-7 / spec-515 dec-3).\n" +
      "Resolve it before deploying — rename the tenant via the spec-479 rename +\n" +
      "redirect path, or mount the API route under a different root.",
  );
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // Fail closed: an unreachable DB or a schema surprise is "unknown", not "clean".
    console.error("[reserved-root-check] check could not complete:", err);
    process.exit(2);
  });
