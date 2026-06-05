// Unit tests for middleware/memex-resolver.ts.
//
// Covers parseMemexPath shape rejection (existing) plus b-38 A4: malformed
// /api/ paths that LOOK like intended tenant resolution but fail the strict
// slug grammar must return 400, not silently no-op (which would otherwise let
// sessionMiddleware auto-resolve a single-membership user to their own memex
// regardless of what URL they actually typed).

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
