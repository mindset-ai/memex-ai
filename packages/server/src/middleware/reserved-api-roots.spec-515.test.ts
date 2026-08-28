// spec-515 (t-8): every flat `/api/<root>` mount in app.ts must be exempt from tenant
// resolution — i.e. its first path segment is in RESERVED_API_ROOTS (memex-resolver.ts).
// When a flat root is missing, parseMemexPath reads `/api/<root>/<x>` as a tenant address
// and the global memexResolver 404s the request BEFORE the router runs.
//
// That class of bug has recurred repeatedly — stripe (spec-171), postmark (spec-341),
// internal (spec-453), then nine more surfaced in 2026-08. The sharpest instance:
// `/api/test-events/batch` 404'd, so the CI AC-emitter fell back from one batch request
// to unbounded per-event POSTs (emitBatch: 404 → Promise.all(single)) — ~11.6M
// (⚠ that figure is the whole emission path's statement volume, and restoring /batch
//  removes the REQUEST amplification, not those statements — six of seven are per-event
//  either way. Corrected in routes/api-roots.ts; spec-520 issue-2.)
// INSERT/DELETE/upsert calls that drove prod Cloud SQL to ~100% CPU.
//
// This scan derives the flat roots from app.ts SOURCE (never hardcoded) and fails if any
// SLUG_RE-shaped root is left unexempt, so the class cannot recur silently under review.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseMemexPath } from "./memex-resolver.js";

const APP_TS = readFileSync(join(__dirname, "..", "app.ts"), "utf-8");

// std-3 slug shape. A first segment that does NOT match this is already rejected by
// parseMemexPath before the reserved-root check (e.g. `__test__`, `__dev__`), so only
// SLUG_RE-shaped roots can be mis-read as a namespace and therefore need exemption.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;

// The nine roots this Spec adds — asserted explicitly as a readable floor on top of the
// derived scan (so the intent is legible even if app.ts is later reshaped).
const SPEC_515_ROOTS = [
  "issues",
  "acs",
  "test-events",
  "spec-checkout",
  "live",
  "telemetry",
  "whats-new",
  "email",
  "hook-keys",
];

// Every literal `/api/<root>` mount. Tenant mounts start `/api/:namespace/...`; the
// leading char class excludes ':' so those are NOT captured — they ARE tenant paths and
// must stay resolvable.
//
// TWO mount forms are recognised, because spec-515 t-6 introduced a helper AFTER this
// test was written:
//   1. `mountFlatApi(app, "<root>", …)` — the current form. The helper also refuses to
//      mount an undeclared root at boot, so this scan is now the second line of defence
//      rather than the only one.
//   2. `app.route|use|get|... ("/api/<root>"` — still used by deep mounts
//      (`/api/stripe/webhook`) and direct handlers (`app.get("/api/health")`), which the
//      helper does not cover.
//
// The guard-the-guard assertion below is what caught the t-6 restructure: when the
// helper landed, form 1 was invisible here and the count fell from 36 to 7, failing
// loudly instead of passing vacuously. Keep that assertion.
//
// A broader sibling lives in __regression__/flat-api-mount-invariant.spec-515.regression.test.ts
// (both halves of the invariant, plus a no-raw-app.route scan). The overlap is deliberate:
// this class of defect recurred six times, so two independent readings are worth their cost.
function flatApiRoots(src: string): string[] {
  const patterns = [
    /mountFlatApi\(\s*app\s*,\s*["'`]([a-z0-9][a-z0-9-]*)/g,
    /app\.(?:route|use|get|post|put|patch|delete)\(\s*["'`]\/api\/([a-z0-9][a-z0-9-]*)/g,
  ];
  const roots = new Set<string>();
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) roots.add(m[1]);
  }
  return [...roots].sort();
}

describe("spec-515: every flat /api mount root is exempt from tenant resolution", () => {
  const roots = flatApiRoots(APP_TS);

  it("the scan actually sees the flat mounts (guards against a vacuous pass)", () => {
    // A silently-shrinking match set is precisely how an earlier sibling guard passed
    // vacuously. Assert the scan sees a realistic number of mounts, including the
    // incident root, so an empty/broken regex fails loudly rather than passing green.
    expect(roots.length).toBeGreaterThanOrEqual(20);
    expect(roots).toContain("test-events");
  });

  it("no SLUG_RE-shaped flat root is read as a tenant namespace", () => {
    const leaked = roots.filter(
      (root) => SLUG_RE.test(root) && parseMemexPath(`/api/${root}/probe`) !== null,
    );
    expect(
      leaked,
      `these flat /api mounts are NOT in RESERVED_API_ROOTS, so /api/<root>/... 404s ` +
        `before the router runs (add them to memex-resolver.ts): ${leaked.join(", ")}`,
    ).toEqual([]);
  });

  it("the nine spec-515 roots resolve to exempt", () => {
    for (const root of SPEC_515_ROOTS) {
      expect(parseMemexPath(`/api/${root}/x`), `${root} should be exempt`).toBeNull();
    }
  });

  it("a genuine tenant path still resolves (the exemption did not over-reach)", () => {
    expect(parseMemexPath("/api/acme/website/docs")).toEqual({
      namespaceSlug: "acme",
      memexSlug: "website",
    });
  });
});
