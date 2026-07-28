// Unit tests for middleware/memex-resolver.ts.
//
// Covers parseMemexPath shape rejection (existing) plus b-38 A4: malformed
// /api/ paths that LOOK like intended tenant resolution but fail the strict
// slug grammar must return 400, not silently no-op (which would otherwise let
// sessionMiddleware auto-resolve a single-membership user to their own memex
// regardless of what URL they actually typed).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";

vi.mock("../db/connection.js", () => ({
  db: {
    query: {
      namespaces: { findFirst: vi.fn().mockResolvedValue(null) },
      memexes: { findFirst: vi.fn().mockResolvedValue(null) },
    },
  },
}));

import { Hono } from "hono";
import { tagAc } from "@memex-ai-ac/vitest";
import { memexResolver, parseMemexPath } from "./memex-resolver.js";

const app = new Hono();
app.use("/*", memexResolver);
app.all("*", (c) => c.json({ ok: true }));

describe("parseMemexPath", () => {
  it("returns null for malformed double-slash paths", () => {
    expect(parseMemexPath("/api//foo/bar/docs")).toBeNull();
    expect(parseMemexPath("//foo/bar/docs")).toBeNull();
  });

  it("returns null for dot-segment paths", () => {
    expect(parseMemexPath("/api/./foo/bar")).toBeNull();
    expect(parseMemexPath("/api/../foo/bar")).toBeNull();
  });

  it("returns null for URL-encoded-slash slugs", () => {
    expect(parseMemexPath("/api/%2Ffoo/bar/docs")).toBeNull();
    expect(parseMemexPath("/api/foo/%2Fbar/docs")).toBeNull();
  });

  it("returns the slug pair for a well-formed tenant path", () => {
    expect(parseMemexPath("/api/mindset/memex-app/docs")).toEqual({
      namespaceSlug: "mindset",
      memexSlug: "memex-app",
    });
    expect(parseMemexPath("/mindset/memex-app/docs")).toEqual({
      namespaceSlug: "mindset",
      memexSlug: "memex-app",
    });
  });

  it("returns null for reserved API roots", () => {
    expect(parseMemexPath("/api/orgs/check")).toBeNull();
    expect(parseMemexPath("/api/health")).toBeNull();
  });

  it("treats /api/internal/* as non-tenant, not namespace=internal (spec-453 t-6)", () => {
    // Regression: /api/internal/lifecycle-tick has two segments, so without the
    // reserved-root entry it resolves as namespace=internal / memex=lifecycle-tick and
    // 404s before the scheduler endpoint runs. Must parse to null (non-tenant).
    tagAc("mindset-prod/memex-building-itself/specs/spec-453/acs/ac-20");
    expect(parseMemexPath("/api/internal/lifecycle-tick")).toBeNull();
  });
});

// b-38 A4 — URL-encoded path-separator guard.
//
// Bare `//` and `..` are handled by WHATWG URL normalization before the request
// reaches the middleware (Hono inherits this from Node's URL parser). The
// genuine gap is `%2F` / `%5C` — URL-encoded slashes / backslashes survive
// end-to-end to avoid changing segment boundaries.
//
// Pre-fix: `/api/%2Ffoo/bar/docs` slipped through parseMemexPath silently;
// memexResolver no-op'd; sessionMiddleware auto-resolved single-membership
// users to their own memex regardless of what they typed.
// Post-fix: any URL-encoded path separator in the request path → 400.
describe("memexResolver malformed-path guard (b-38 A4)", () => {
  it("returns 400 when the request path contains %2F (URL-encoded slash)", async () => {
    const res = await app.request("/api/%2Ffoo/bar/docs");
    expect(res.status).toBe(400);
  });

  it("returns 400 for lowercase %2f variant", async () => {
    const res = await app.request("/api/%2ffoo/bar/docs");
    expect(res.status).toBe(400);
  });

  it("returns 400 when %2F appears in the memex slug position", async () => {
    const res = await app.request("/api/mindset/%2Fmemex-app/docs");
    expect(res.status).toBe(400);
  });

  // Note: %5C (URL-encoded backslash) is normalized to `/` by WHATWG URL
  // parsing before middleware sees it (backslash is a special character in
  // http/https schemes). The defensive check for it in memex-resolver.ts is
  // belt-and-suspenders against future URL-parser changes, but cannot be
  // exercised through Hono's test client today.

  it("does NOT 400 on legitimate tenant paths", async () => {
    // Real namespace/memex slugs fall through to ns lookup; mocked DB returns
    // null → 404. The 400 must NOT fire here, since the path is well-formed.
    const res = await app.request("/api/mindset/memex-app/docs");
    expect(res.status).toBe(404);
  });

  it("does NOT 400 on reserved API roots (no tenant resolution expected)", async () => {
    const orgsRes = await app.request("/api/orgs/check");
    expect(orgsRes.status).toBe(200);
    const healthRes = await app.request("/api/health");
    expect(healthRes.status).toBe(200);
  });

  it("does NOT 400 on browser-style paths (no /api/ prefix)", async () => {
    // The API resolver should not gate browser routes; React Router handles them.
    // Note: WHATWG already normalizes `//foo/bar` to `/foo/bar` before this point,
    // so `//foo/bar` arrives as `/foo/bar` and the resolver attempts ns lookup
    // (mocked DB returns null → 404).
    const res = await app.request("/foo/bar");
    expect(res.status).toBe(404);
  });
});

// spec-515 t-2 / ac-8 — every flat `/api/<root>` mount must be exempt from
// tenant parsing.
//
// memexResolver is registered as `app.use("*", …)` BEFORE any route, so it sees
// the path first. parseMemexPath reads `/api/<a>/<b>` as a tenant address, which
// means a flat mount whose root is missing from RESERVED_API_ROOTS has its
// SUBPATHS swallowed: the resolver looks up a namespace that doesn't exist and
// returns 404 per std-7 before the router ever runs.
//
// The bare mount always works — `/api/test-events` has one segment after /api,
// so parseMemexPath returns null on the length check. Only the subpath breaks.
// That asymmetry is why this shipped unnoticed: see the `stripe`, `postmark` and
// `internal` comments in memex-resolver.ts, each describing this same failure.
//
// Measured against prod on 2026-07-27: nine mounts unguarded.
// `/api/email/unsubscribe` (the RFC 8058 one-click target carried on every
// lifecycle email) had 404'd since 2026-07-01, and `/api/test-events/batch` had
// silently disabled spec-489's CI-burst batching, driving Cloud SQL CPU to 100%.
//
// Derived from app.ts source rather than a hardcoded list, so a NEW flat mount is
// covered the day it lands. Deliberately NOT written with `app.request(...)`:
// this file mocks db/connection.js (top of file), and that mock is precisely why
// six batch-route tests pass in routes/test-events.test.ts while production 404s.
// A route-level assertion here would inherit the same blind spot.
const APP_SRC = readFileSync(
  fileURLToPath(new URL("../app.ts", import.meta.url)),
  "utf8",
);

// Matches the mount forms app.ts actually uses: `mountFlatApi(app, "<root>", …)`
// (spec-515 t-6 — the helper that ties a mount to its exemption) and any surviving
// `app.use("/api/<root>/*", …)` middleware pairing. The character class excludes `:`
// and `*`, so tenant-prefixed mounts and the catch-all (`/api/*`) are skipped.
const FLAT_API_MOUNT_ROOTS = [
  ...new Set(
    [
      ...APP_SRC.matchAll(
        /mountFlatApi\(\s*app\s*,\s*"([a-z0-9-]+)"|app\.(?:route|use)\(\s*"\/api\/([a-z0-9-]+)(?:\/\*)?"/g,
      ),
    ].map((m) => m[1] ?? m[2]),
  ),
].sort();

describe("flat /api/<root> mounts survive tenant resolution (spec-515)", () => {
  it("finds the flat mounts it is meant to guard", () => {
    // Guards the guard: if the regex stops matching after a refactor changes how
    // mounts are registered, the assertions below would vacuously pass.
    expect(FLAT_API_MOUNT_ROOTS.length).toBeGreaterThan(20);
    expect(FLAT_API_MOUNT_ROOTS).toContain("test-events");
    expect(FLAT_API_MOUNT_ROOTS).toContain("email");
  });

  it("returns null for a subpath under every flat mount root", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-515/acs/ac-8");
    const swallowed = FLAT_API_MOUNT_ROOTS.filter(
      (root) => parseMemexPath(`/api/${root}/anything`) !== null,
    );
    // Named rather than counted so a failure says WHICH mount is unreachable.
    expect(swallowed).toEqual([]);
  });

  it("still resolves a genuine two-segment tenant path", () => {
    // The fix must not over-reach: a real `/api/<ns>/<mx>/…` must still parse.
    expect(
      parseMemexPath("/api/mindset-prod/memex-building-itself/docs"),
    ).toEqual({
      namespaceSlug: "mindset-prod",
      memexSlug: "memex-building-itself",
    });
  });

  // Named anchors for the five paths observed 404ing in production, so a future
  // regression reports the user-visible consequence, not just a bare root.
  it.each([
    ["/api/email/unsubscribe", "RFC 8058 one-click unsubscribe target"],
    ["/api/test-events/batch", "spec-489 CI-burst batch ingest"],
    ["/api/acs/doc/some-uuid", "AC lookup by doc"],
    ["/api/issues/some-uuid", "issue lookup"],
    ["/api/hook-keys/some-uuid/revoke", "hook-key revoke"],
  ])("does not swallow %s (%s)", (path) => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-515/acs/ac-8");
    expect(parseMemexPath(path)).toBeNull();
  });
});
