import { describe, it, expect, vi } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  ensureHookKey,
  keyForMemex,
  authUrlFor,
} from "../lib/checkout-bootstrap.js";
import { parseArgs } from "../lib/argv.js";

// spec-371 t-5 — the first-run credential bootstrap (dec-10). One device-flow
// sign-in mints the scoped mxh_ key and stores it where the edit hook reads it;
// never pasted; idempotent (a stored key triggers no sign-in).
const AC_18 = "mindset-prod/memex-building-itself/specs/spec-371/acs/ac-18";
const MEMEX = "mindset-prod/memex-building-itself";

// In-memory ~/.memex/checkout.json double.
function memFs(initial = null) {
  let content = initial;
  return {
    read: () => {
      if (content == null) {
        const e = new Error("ENOENT");
        e.code = "ENOENT";
        throw e;
      }
      return content;
    },
    write: (_p, c) => {
      content = c;
    },
    mkdirp: () => {},
    current: () => (content == null ? null : JSON.parse(content)),
  };
}

describe("first-run credential bootstrap (spec-371 ac-18)", () => {
  it("with a stored key for the memex, does NOT sign in (idempotent)", async () => {
    tagAc(AC_18);
    const fs = memFs(
      JSON.stringify({ api_base: "https://memex.ai", keys: { [MEMEX]: "mxh_existing" } }),
    );
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    const res = await ensureHookKey({
      apiBase: "https://memex.ai",
      memexRef: MEMEX,
      fs,
      deps: { storePath: "/fake", fetch },
    });
    expect(res).toMatchObject({ provisioned: false, signedIn: false, key: "mxh_existing" });
    expect(fetch).not.toHaveBeenCalled(); // zero network — no sign-in, no mint
  });

  it("with no stored key: ONE device-flow sign-in, mint, store per-memex; never pasted", async () => {
    tagAc(AC_18);
    const fs = memFs(null);
    const calls = [];
    const fetch = async (url, init) => {
      calls.push(url);
      if (url.endsWith("/api/cli/auth/start"))
        return { ok: true, json: async () => ({ reqId: "r1", code: "ABCD" }) };
      if (url.includes("/api/cli/auth/poll/"))
        return { ok: true, json: async () => ({ status: "completed", token: "mxt_user" }) };
      if (url.endsWith(`/api/${MEMEX}/hook-keys`)) {
        // minted off the signed-in user token, membership-gated route
        expect(init.headers.Authorization).toBe("Bearer mxt_user");
        return { ok: true, json: async () => ({ key: "mxh_minted" }) };
      }
      throw new Error("unexpected fetch " + url);
    };
    const opened = [];
    const res = await ensureHookKey({
      apiBase: "https://memex.ai",
      memexRef: MEMEX,
      fs,
      deps: { storePath: "/fake", fetch, openBrowser: (u) => opened.push(u), now: () => 0 },
    });
    expect(res).toMatchObject({ provisioned: true, signedIn: true, key: "mxh_minted" });
    // exactly ONE sign-in handshake
    expect(calls.filter((u) => u.endsWith("/api/cli/auth/start"))).toHaveLength(1);
    expect(opened[0]).toBe("https://memex.ai/install/mcp/auth?code=ABCD");
    // stored where the edit hook reads it, keyed by memex — no key ever entered by hand
    expect(fs.current().keys[MEMEX]).toBe("mxh_minted");
  });

  it("a mint failure propagates — fail loud, not silently keyless", async () => {
    tagAc(AC_18);
    const fs = memFs(null);
    const fetch = async (url) => {
      if (url.endsWith("/api/cli/auth/start"))
        return { ok: true, json: async () => ({ reqId: "r", code: "C" }) };
      if (url.includes("/poll/"))
        return { ok: true, json: async () => ({ status: "completed", token: "t" }) };
      return { ok: false, status: 403, text: async () => "forbidden" };
    };
    await expect(
      ensureHookKey({
        apiBase: "https://memex.ai",
        memexRef: MEMEX,
        fs,
        deps: { storePath: "/f", fetch, now: () => 0 },
      }),
    ).rejects.toThrow(/403/);
  });

  it("keyForMemex prefers the per-memex key, falls back to a legacy single key", () => {
    tagAc(AC_18);
    expect(keyForMemex({ keys: { [MEMEX]: "mxh_a" } }, MEMEX)).toBe("mxh_a");
    expect(keyForMemex({ hook_key: "mxh_legacy" }, MEMEX)).toBe("mxh_legacy");
    expect(keyForMemex({}, MEMEX)).toBe(null);
  });

  it("authUrlFor builds the confirm-page URL the user signs in on", () => {
    tagAc(AC_18);
    expect(authUrlFor("https://memex.ai", "WXYZ")).toBe(
      "https://memex.ai/install/mcp/auth?code=WXYZ",
    );
  });

  it("the CLI exposes a `checkout-setup --memex` trigger for the one-time mint", () => {
    tagAc(AC_18);
    const parsed = parseArgs(["node", "cli", "checkout-setup", "--memex", MEMEX]);
    expect(parsed.command).toBe("checkout-setup");
    expect(parsed.memex).toBe(MEMEX);
  });
});
