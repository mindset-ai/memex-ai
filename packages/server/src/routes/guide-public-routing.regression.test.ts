// spec-222 t-10 — regression: the public /guide/v1 mount must NOT be shadowed by
// the global memexResolver. The router's own tests (guide-public.test.ts) mount it
// on a BARE Hono app without hostGuard/memexResolver, so they never caught that
// `parseMemexPath("/guide/v1/…")` was reading it as namespace=guide / memex=v1 and
// returning 404 before the router ran. This pins the fix through the REAL app
// middleware stack (the same pattern as __e2e__/path-routing.api.test.ts). (ac-14)

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { app } from "../app.js";
import { parseMemexPath } from "../middleware/memex-resolver.js";

const AC_14 = "mindset-prod/memex-building-itself/specs/spec-222/acs/ac-14";

describe("spec-222 t-10: /guide/v1 is not shadowed by tenant resolution (ac-14)", () => {
  it("parseMemexPath treats /guide/v1/… as an app mount, not a <namespace>/<memex>", () => {
    tagAc(AC_14);
    // "guide" is a reserved API root → null (no tenant resolution attempted).
    expect(parseMemexPath("/guide/v1/session")).toBeNull();
    expect(parseMemexPath("/guide/v1/voice")).toBeNull();
    expect(parseMemexPath("/guide/v1/chat")).toBeNull();
    // A genuine tenant path still resolves (guard against over-reservation).
    expect(parseMemexPath("/acme/team/api/me")).toEqual({ namespaceSlug: "acme", memexSlug: "team" });
  });

  it("POST /guide/v1/session reaches the public router through the full middleware stack (not 404)", async () => {
    tagAc(AC_14);
    const res = await app.request("/guide/v1/session", {
      method: "POST",
      headers: {
        host: "localhost",
        origin: "http://localhost:8000",
        "content-type": "application/json",
      },
      body: JSON.stringify({ surface: "memex-website" }),
    });
    // THE regression: memexResolver mis-parsing → 404 before the router. Must not happen.
    expect(res.status).not.toBe(404);
    // The public router handles it: 201 (token minted) on a fresh limiter, or 429 if
    // the per-IP cap was already spent this worker — either way the route is reachable.
    expect([200, 201, 429]).toContain(res.status);
    if (res.status === 200 || res.status === 201) {
      const body = await res.json();
      expect(typeof body.token).toBe("string");
      expect(body.surface).toBe("memex-website");
    }
  });
});
