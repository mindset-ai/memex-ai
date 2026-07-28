// spec-515 t-8 / ac-4, ac-11 — the whole-class guard: a flat `/api/<root>` mount
// cannot exist without BOTH halves of its invariant.
//
// WHY A DEDICATED REGRESSION FILE. This defect has recurred six times. `stripe`,
// `postmark` and `internal` each carry an in-code comment describing the exact
// failure, and it still happened three more times (`email`, `test-events`, and the
// seven latent roots). Comments and review did not hold. The individual assertions
// also exist closer to their subjects (routes/flat-api-mounts.test.ts,
// services/shared/slug.reserved-composition.spec-515.test.ts) — this file is the
// single place that states the CLASS, so a reader grepping for "why can't I just
// app.route a new /api root" lands on one explanation.
//
// THE INVARIANT, both halves. For every reserved `/api` root:
//   1. `parseMemexPath` returns null for it → its subpaths reach the router instead
//      of being swallowed by tenant resolution (the spec-515 production defect).
//   2. `validateSlugFormat` refuses it → no tenant can claim the word and be made
//      unroutable by half 1 (std-3 cl-7, amended 2026-07-28).
// Either half alone leaves a live defect, which is why they are asserted together.
//
// DELIBERATELY NO `app.request(...)` AND NO DB MOCK. A route-level assertion cannot
// see this defect: `routes/test-events.test.ts` builds its own Hono and mocks
// `db/connection`, so its six batch-route tests pass while production 404s. This
// file asserts against the pure functions and the declaration, so there is nothing
// to mock and nothing to be blinded by.
//
// TEETH. Each assertion below was verified to FAIL by breaking the code it guards —
// see the task record on spec-515 t-8 for the three experiments and their output.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  FLAT_API_MOUNT_ROOTS,
  NON_FLAT_RESERVED_ROOTS,
  reservedApiRoots,
} from "../routes/api-roots.js";
import { parseMemexPath } from "../middleware/memex-resolver.js";
import { validateSlugFormat } from "../services/shared/slug.js";

const AC_CLASS = "mindset-prod/memex-building-itself/specs/spec-515/acs/ac-4";
const AC_GUARD = "mindset-prod/memex-building-itself/specs/spec-515/acs/ac-11";

const APP_SRC = readFileSync(
  fileURLToPath(new URL("../app.ts", import.meta.url)),
  "utf8",
);

/** Roots app.ts actually mounts flat, read from source. */
const MOUNTED_IN_APP = [
  ...new Set(
    [...APP_SRC.matchAll(/mountFlatApi\(\s*app\s*,\s*"([a-z0-9-]+)"/g)].map(
      (m) => m[1],
    ),
  ),
].sort();

describe("flat /api mount invariant (spec-515 t-8)", () => {
  it("finds the mounts it is meant to guard", () => {
    // Guards the guard. If the mount form changes and this scan silently matches
    // nothing, every assertion below would pass vacuously — the worst outcome for
    // a guard test, since it reports safety it is not checking.
    tagAc(AC_GUARD);
    expect(MOUNTED_IN_APP.length).toBeGreaterThan(20);
    expect(MOUNTED_IN_APP).toContain("email");
    expect(MOUNTED_IN_APP).toContain("test-events");
  });

  it("every root mounted in app.ts is declared", () => {
    // `mountFlatApi` also throws at boot for an undeclared root, so this is
    // belt-and-braces — but it fails at PR time with a readable diff rather than
    // as an import error inside whichever test happened to load the app first.
    tagAc(AC_GUARD);
    const undeclared = MOUNTED_IN_APP.filter((r) => !FLAT_API_MOUNT_ROOTS.has(r));
    expect(undeclared).toEqual([]);
  });

  it("half 1 — every reserved root is exempt from tenant parsing", () => {
    tagAc(AC_GUARD);
    const swallowed = [...reservedApiRoots()].filter(
      (root) => parseMemexPath(`/api/${root}/anything`) !== null,
    );
    expect(swallowed).toEqual([]);
  });

  it("half 2 — every reserved root is unclaimable as a namespace slug", () => {
    tagAc(AC_GUARD);
    const claimable = [...reservedApiRoots()].filter(
      (root) => validateSlugFormat(root).valid,
    );
    expect(claimable).toEqual([]);
  });

  it("no raw app.route(\"/api/<root>\") bypasses the mount helper", () => {
    // The escape hatch dec-7 accepted when it chose option A over a full
    // restructure. This scan is what closes it. Deep mounts
    // (`/api/stripe/webhook`), tenant-prefixed mounts (`/api/:namespace/...`) and
    // the catch-all (`/api/*`) are out of scope — only a flat single-segment root.
    tagAc(AC_CLASS);
    const raw = [
      ...APP_SRC.matchAll(/app\.route\(\s*"\/api\/([a-z0-9-]+)"\s*,/g),
    ].map((m) => m[1]);
    expect(raw).toEqual([]);
  });

  it("keeps the hand-maintained half small and auditable", () => {
    // dec-7's argument for splitting the vocabulary was that the part needing human
    // judgement stays small enough to review. If NON_FLAT_RESERVED_ROOTS starts
    // growing, that argument has quietly expired and the split needs revisiting.
    tagAc(AC_CLASS);
    expect(NON_FLAT_RESERVED_ROOTS.size).toBeLessThanOrEqual(12);
  });

  it("does not over-reach — a genuine tenant path still resolves", () => {
    tagAc(AC_GUARD);
    expect(parseMemexPath("/api/mindset-prod/memex-building-itself/docs")).toEqual({
      namespaceSlug: "mindset-prod",
      memexSlug: "memex-building-itself",
    });
  });
});
