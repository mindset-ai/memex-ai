// spec-515 (t-8): every flat `/api/<root>` mount in app.ts must be exempt from tenant
// resolution — i.e. its first path segment is in RESERVED_API_ROOTS (memex-resolver.ts).
// When a flat root is missing, parseMemexPath reads `/api/<root>/<x>` as a tenant address
// and the global memexResolver 404s the request BEFORE the router runs.
//
// That class of bug has recurred repeatedly — stripe (spec-171), postmark (spec-341),
// internal (spec-453), then nine more surfaced in 2026-08. The sharpest instance:
// `/api/test-events/batch` 404'd, so the CI AC-emitter fell back from one batch request
// to unbounded per-event POSTs (emitBatch: 404 → Promise.all(single)) — ~11.6M
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

// Every literal `/api/<root>` mount (app.route/use/get/post/...). Tenant mounts start
// `/api/:namespace/...`; the leading char class excludes ':' so those are NOT captured —
// they ARE tenant paths and must stay resolvable.
function flatApiRoots(src: string): string[] {
  const re =
    /app\.(?:route|use|get|post|put|patch|delete)\(\s*["'`]\/api\/([a-z0-9][a-z0-9-]*)/g;
  const roots = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) roots.add(m[1]);
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
