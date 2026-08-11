// spec-515 t-3 / ac-6 — no live tenant is stranded by the reserved-root fix.
//
// THE HAZARD. Adding a root to the exempt vocabulary makes `parseMemexPath` no-op for
// it, which is what makes a flat `/api/<root>` mount reachable — and what would make
// a tenant that already OWNS that word as its namespace slug unroutable, because
// `/<root>/<memex>/…` would stop resolving. The two features compete for one
// vocabulary (std-3 cl-7) and this is the interlock.
//
// WHY A SMOKE-TIER CHECK AND NOT ONLY THE DEPLOY GATE. `deploy.sh` already runs the
// same function as a gating pre-condition before migrations (t-3), so a deploy cannot
// proceed over a collision. But that gate only fires when someone deploys. This tier
// makes the same claim checkable ON DEMAND against a live database — which is what
// ac-6 asks for ("prod and int are confirmed…"), and what turns a one-off manual
// query into something a reviewer can re-run.
//
// dec-3 verified by hand on 2026-07-28: prod (328 namespaces) and int (78) both
// clear, for the nine new roots, the 21 already-reserved ones, and the post-rename
// reservation table. That was a point-in-time observation — a namespace can be
// created at any moment — so the value here is the repeatability, not the first pass.
//
// DB tier: skips cleanly when SMOKE_DATABASE_URL is unset (std-26 gotcha #8 —
// "skipped" is the normal green for a run without credentials). Requires a
// cloud-sql-proxy. STRICTLY READ-ONLY: SELECTs only, against production data.
//
//   cloud-sql-proxy --port 15432 memex-ai-prod:us-east4:memex-prod &
//   SMOKE_DATABASE_URL="postgresql://…@localhost:15432/memex" \
//     pnpm --filter @memex/server smoke

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { reservedApiRoots } from "../routes/api-roots.js";
import { SMOKE_DATABASE_URL, SMOKE_ENV } from "./smoke-env.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-515/acs/ac-6";

const ENABLED = !!SMOKE_DATABASE_URL;

describe.skipIf(!ENABLED)(
  `reserved-root collision smoke @ ${SMOKE_ENV || "(env unset)"}`,
  () => {
    let sql: ReturnType<typeof postgres>;
    // Read-only by construction as well as by intent: the role may still be a
    // superuser on some envs, so the queries below are the only guarantee.
    beforeAll(() => {
      sql = postgres(SMOKE_DATABASE_URL, { max: 2 });
    });
    afterAll(async () => {
      await sql?.end?.({ timeout: 5 });
    });

    it("no namespace slug and no post-rename reservation squats a reserved API root", async () => {
      tagAc(AC);
      const roots = [...reservedApiRoots()];
      // Guard the guard: an empty vocabulary would make both queries trivially
      // return nothing and the assertion pass while checking nothing at all.
      expect(roots.length).toBeGreaterThan(20);

      const [claimed, held, total] = await Promise.all([
        sql<{ slug: string }[]>`select slug from namespaces where slug = any(${sql.array(roots)})`,
        sql<{ slug: string }[]>`select slug from namespace_slug_reservations where slug = any(${sql.array(roots)})`,
        sql<{ n: number }[]>`select count(*)::int as n from namespaces`,
      ]);

      // Sanity: prove the queries actually saw data rather than being masked by
      // row-level security (std-36 uses ENABLE, not FORCE, but the runtime role is
      // non-owner). Without this, "no collisions" could mean "no visibility".
      expect(total[0].n).toBeGreaterThan(0);

      // Named, not counted, so a failure says WHICH tenant is about to be stranded
      // and by which word.
      expect({
        namespaces: claimed.map((r) => r.slug).sort(),
        reservations: held.map((r) => r.slug).sort(),
      }).toEqual({ namespaces: [], reservations: [] });
    });
  },
);
