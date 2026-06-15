// Unit tests for the memex_known hint cookie (mindset-prod/memex-website spec-15).
//
// These are pure HTTP-surface tests: a tiny Hono app whose only route calls
// setKnownCookie, driven with app.request(). No database is touched, so this file
// runs under `make test-unit` even with no Postgres available.

import { describe, it, expect, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";
import { setKnownCookie } from "./helpers.js";

const AC = (n: number) => `mindset-prod/memex-website/specs/spec-15/acs/ac-${n}`;

// Build a throwaway app that sets the cookie and returns 200, then read the
// Set-Cookie header it emits for the given APP_BASE_URL host.
async function setCookieHeaderFor(appBaseUrl: string | undefined): Promise<string> {
  if (appBaseUrl === undefined) {
    vi.stubEnv("APP_BASE_URL", "");
    // empty string is falsy → helper falls back to its localhost default
  } else {
    vi.stubEnv("APP_BASE_URL", appBaseUrl);
  }
  const app = new Hono();
  app.get("/probe", (c) => {
    setKnownCookie(c);
    return c.text("ok");
  });
  const res = await app.request("/probe");
  return res.headers.get("set-cookie") ?? "";
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("setKnownCookie — attributes on a memex.ai host (spec-15 ac-1, ac-6, ac-7)", () => {
  it("emits memex_known=1 with Domain=.memex.ai, Secure, SameSite=Lax, ~1yr Max-Age, and no HttpOnly", async () => {
    tagAc(AC(1)); // memex_known=1 scoped to Domain=.memex.ai
    tagAc(AC(6)); // ~1yr Max-Age
    tagAc(AC(7)); // Secure, SameSite=Lax, HttpOnly unset
    const header = await setCookieHeaderFor("https://prod.memex.ai");

    expect(header).toMatch(/(^|[,;\s])memex_known=1(;|$)/);
    expect(header).toMatch(/Domain=\.memex\.ai/i);
    expect(header).toMatch(/Secure/i);
    expect(header).toMatch(/SameSite=Lax/i);
    // ~1 year, allowing for any future rounding.
    const maxAge = Number(header.match(/Max-Age=(\d+)/i)?.[1]);
    expect(maxAge).toBeGreaterThanOrEqual(60 * 60 * 24 * 364);
    // It must NOT be HttpOnly — the marketing site reads it from document.cookie.
    expect(header).not.toMatch(/HttpOnly/i);
  });

  it("also pins Domain=.memex.ai on the bare apex host", async () => {
    tagAc(AC(7));
    const header = await setCookieHeaderFor("https://memex.ai");
    expect(header).toMatch(/Domain=\.memex\.ai/i);
  });
});

describe("setKnownCookie — non-memex.ai host gating (spec-15 ac-8)", () => {
  it("omits the Domain attribute on localhost so dev login still works", async () => {
    tagAc(AC(8));
    const header = await setCookieHeaderFor("http://localhost:5173");
    expect(header).toMatch(/memex_known=1/);
    expect(header).not.toMatch(/Domain=/i);
    // Secure is relaxed off the memex.ai domain so the cookie survives http://localhost.
    expect(header).not.toMatch(/Secure/i);
  });

  it("falls back to the localhost default when APP_BASE_URL is unset (no Domain)", async () => {
    tagAc(AC(8));
    const header = await setCookieHeaderFor(undefined);
    expect(header).toMatch(/memex_known=1/);
    expect(header).not.toMatch(/Domain=/i);
  });

  it("omits Domain on an unrelated host (e.g. a preview deployment)", async () => {
    tagAc(AC(8));
    const header = await setCookieHeaderFor("https://memex-preview.example.com");
    expect(header).not.toMatch(/Domain=/i);
  });
});

describe("memex_known is write-only — never read for authz (spec-15 ac-4, ac-6)", () => {
  it("no server source reads the cookie; helpers.ts is the only place it appears", () => {
    tagAc(AC(4));
    // ac-6: nothing (e.g. a logout route) ever deletes/expires the cookie — proven by
    // the cookie name appearing in exactly one non-test source, the writer below.
    const authDir = dirname(fileURLToPath(import.meta.url));
    const serverSrc = join(authDir, "..", "..");

    // Walk every .ts file under packages/server/src (excluding test files) and
    // collect references to the cookie name.
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules") continue;
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        if (entry.name.includes(".test.")) continue;
        const text = readFileSync(full, "utf8");
        if (text.includes("memex_known")) hits.push(full);
      }
    };
    walk(serverSrc);

    // The ONLY non-test source that may mention the cookie is the writer in
    // auth/helpers.ts. Any other hit means something is reading it back — which
    // would risk it being used in an auth decision.
    const offenders = hits.filter((f) => !f.endsWith(join("auth", "helpers.ts")));
    expect(offenders).toEqual([]);

    // And the one allowed hit must only ever SET the cookie (getCookie would be a read).
    const helpers = readFileSync(
      join(authDir, "helpers.ts"),
      "utf8",
    );
    expect(helpers).toContain("setCookie");
    expect(helpers).not.toMatch(/getCookie\s*\(\s*[^,]*,\s*["'`]memex_known/);
    // ac-6: the writer never deletes/expires it either.
    tagAc(AC(6));
    expect(helpers).not.toMatch(/deleteCookie\s*\(\s*[^,]*,\s*["'`]memex_known/);
  });
});
