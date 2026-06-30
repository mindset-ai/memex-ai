import { describe, it, expect, vi } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  ensureHookKey,
  provisionHookKey,
  unifiedInstall,
  keyFromStore,
  authUrlFor,
} from "../lib/checkout-bootstrap.js";
import { parseArgs } from "../lib/argv.js";

// spec-430 — the per-USER checkout credential + the unified one-sign-in install.
const AC_18 = "mindset-prod/memex-building-itself/specs/spec-371/acs/ac-18"; // bootstrap: 1 sign-in, never pasted, idempotent
const AC_1 = "mindset-prod/memex-building-itself/specs/spec-430/acs/ac-1"; // two actions: one command + one reload
const AC_2 = "mindset-prod/memex-building-itself/specs/spec-430/acs/ac-2"; // exactly one sign-in
const AC_7 = "mindset-prod/memex-building-itself/specs/spec-430/acs/ac-7"; // both creds from one mxt_, no 2nd sign-in
const AC_8 = "mindset-prod/memex-building-itself/specs/spec-430/acs/ac-8"; // user-level mint (no memex in the path)

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

describe("checkout credential bootstrap (spec-430 dec-1/dec-3)", () => {
  it("keyFromStore prefers the single hook_key, falls back to a legacy per-memex map", () => {
    tagAc(AC_8);
    expect(keyFromStore({ hook_key: "mxh_a" })).toBe("mxh_a");
    expect(keyFromStore({ keys: { "ns/m": "mxh_legacy" } })).toBe("mxh_legacy"); // back-compat read
    expect(keyFromStore({})).toBe(null);
  });

  it("authUrlFor builds the confirm-page URL the user signs in on", () => {
    tagAc(AC_18);
    expect(authUrlFor("https://memex.ai", "WXYZ")).toBe(
      "https://memex.ai/install/mcp/auth?code=WXYZ",
    );
  });

  it("provisionHookKey: mints from an EXISTING token at the user-level route — NO sign-in (ac-7, ac-8)", async () => {
    tagAc(AC_7);
    tagAc(AC_8);
    const fs = memFs(null);
    const calls = [];
    const fetch = async (url, init) => {
      calls.push(url);
      if (url.endsWith("/api/hook-keys")) {
        expect(init.headers.Authorization).toBe("Bearer mxt_abc"); // minted off the install token
        return { ok: true, json: async () => ({ key: "mxh_x" }) };
      }
      throw new Error("unexpected fetch " + url);
    };
    const res = await provisionHookKey({
      apiBase: "https://memex.ai",
      token: "mxt_abc",
      fs,
      deps: { storePath: "/f", fetch },
    });
    expect(res).toMatchObject({ provisioned: true, key: "mxh_x" });
    // NEVER touched the device flow — no second sign-in
    expect(calls.some((u) => u.includes("/api/cli/auth/"))).toBe(false);
    // stored as a single user key, no per-memex map
    expect(fs.current().hook_key).toBe("mxh_x");
    expect(fs.current().keys).toBeUndefined();
  });

  it("provisionHookKey: idempotent — an existing key short-circuits with no mint", async () => {
    tagAc(AC_18);
    const fs = memFs(JSON.stringify({ hook_key: "mxh_existing" }));
    const fetch = vi.fn();
    const res = await provisionHookKey({
      apiBase: "https://memex.ai",
      token: "mxt_abc",
      fs,
      deps: { storePath: "/f", fetch },
    });
    expect(res).toMatchObject({ provisioned: false, key: "mxh_existing" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("unifiedInstall: ONE sign-in yields BOTH credentials from the same token (ac-1, ac-2, ac-7)", async () => {
    tagAc(AC_1);
    tagAc(AC_2);
    tagAc(AC_7);
    const fs = memFs(null);
    const calls = [];
    let plantedToken = null;
    const fetch = async (url, init) => {
      calls.push(url);
      if (url.endsWith("/api/cli/auth/start"))
        return { ok: true, json: async () => ({ reqId: "r1", code: "ABCD" }) };
      if (url.includes("/api/cli/auth/poll/"))
        return { ok: true, json: async () => ({ status: "completed", token: "mxt_user" }) };
      if (url.endsWith("/api/hook-keys")) {
        expect(init.headers.Authorization).toBe("Bearer mxt_user");
        return { ok: true, json: async () => ({ key: "mxh_minted" }) };
      }
      throw new Error("unexpected fetch " + url);
    };
    const opened = [];
    const res = await unifiedInstall({
      apiBase: "https://memex.ai",
      fs,
      deps: {
        storePath: "/fake",
        fetch,
        now: () => 0,
        openBrowser: (u) => opened.push(u),
        plantMcp: async (token) => {
          plantedToken = token;
        },
      },
    });
    // exactly ONE device-flow sign-in (ac-2)
    expect(calls.filter((u) => u.endsWith("/api/cli/auth/start"))).toHaveLength(1);
    expect(opened).toEqual(["https://memex.ai/install/mcp/auth?code=ABCD"]);
    // the MCP was planted with the SAME token the hook key was minted from (ac-7)
    expect(plantedToken).toBe("mxt_user");
    expect(res.hook).toMatchObject({ provisioned: true, key: "mxh_minted" });
    // stored as a single user key — never a per-memex map (dec-3)
    expect(fs.current().hook_key).toBe("mxh_minted");
    expect(fs.current().keys).toBeUndefined();
  });

  it("ensureHookKey: a stored key → NO sign-in (idempotent)", async () => {
    tagAc(AC_18);
    const fs = memFs(JSON.stringify({ api_base: "https://memex.ai", hook_key: "mxh_existing" }));
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    const res = await ensureHookKey({
      apiBase: "https://memex.ai",
      fs,
      deps: { storePath: "/fake", fetch },
    });
    expect(res).toMatchObject({ provisioned: false, signedIn: false, key: "mxh_existing" });
    expect(fetch).not.toHaveBeenCalled(); // zero network — no sign-in, no mint
  });

  it("ensureHookKey: no key → ONE sign-in, mint at the user-level route, store ONE key (ac-2, ac-8)", async () => {
    tagAc(AC_2);
    tagAc(AC_8);
    const fs = memFs(null);
    const calls = [];
    const fetch = async (url, init) => {
      calls.push(url);
      if (url.endsWith("/api/cli/auth/start"))
        return { ok: true, json: async () => ({ reqId: "r1", code: "ABCD" }) };
      if (url.includes("/api/cli/auth/poll/"))
        return { ok: true, json: async () => ({ status: "completed", token: "mxt_user" }) };
      if (url.endsWith("/api/hook-keys")) {
        expect(init.headers.Authorization).toBe("Bearer mxt_user");
        return { ok: true, json: async () => ({ key: "mxh_minted" }) };
      }
      throw new Error("unexpected fetch " + url);
    };
    const opened = [];
    const res = await ensureHookKey({
      apiBase: "https://memex.ai",
      fs,
      deps: { storePath: "/fake", fetch, openBrowser: (u) => opened.push(u), now: () => 0 },
    });
    expect(res).toMatchObject({ provisioned: true, signedIn: true, key: "mxh_minted" });
    expect(calls.filter((u) => u.endsWith("/api/cli/auth/start"))).toHaveLength(1);
    expect(opened[0]).toBe("https://memex.ai/install/mcp/auth?code=ABCD");
    expect(fs.current().hook_key).toBe("mxh_minted");
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
        fs,
        deps: { storePath: "/f", fetch, now: () => 0 },
      }),
    ).rejects.toThrow(/403/);
  });

  it("the CLI exposes a `checkout-setup` trigger — no --memex needed (dec-3)", () => {
    tagAc(AC_8);
    const parsed = parseArgs(["node", "cli", "checkout-setup"]);
    expect(parsed.command).toBe("checkout-setup");
  });
});
