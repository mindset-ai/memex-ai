// lib/checkout-bootstrap.js — the per-USER checkout credential (spec-430 dec-1/dec-3).
//
// ONE key per user, minted at the user-level POST /api/hook-keys (no memex in the
// path), stored as a single `hook_key` in ~/.memex/checkout.json — never a per-memex
// map. The edit hook uses that one key for every memex. Entry points:
//   - unifiedInstall(): ONE device-flow sign-in, then both credentials off the same
//     mxt_ token — the caller plants the MCP entry (plantMcp), and we mint the mxh_
//     hook key. No second sign-in (spec-430 dec-2).
//   - provisionHookKey(): mint + store from an EXISTING signed-in token (no sign-in).
//   - ensureHookKey(): standalone — device-flow ONCE then provision.
// Idempotent: a stored hook_key short-circuits with no mint and no sign-in. All IO
// (fetch, browser, clock, fs) is injected so the orchestration unit-tests offline.

import { startCliAuth, pollForToken } from "./auth-flow.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

// The store the edit hook reads: ~/.memex/checkout.json — one user key under `hook_key`.
export function storePath(home = homedir()) {
  return join(home, ".memex", "checkout.json");
}

const DEFAULT_FS = {
  read: (p) => readFileSync(p, "utf8"),
  write: (p, c) => writeFileSync(p, c),
  mkdirp: (d) => mkdirSync(d, { recursive: true }),
};

export function loadStore(path, fs = DEFAULT_FS) {
  try {
    const s = JSON.parse(fs.read(path));
    return s && typeof s === "object" ? s : {};
  } catch {
    return {}; // absent / unreadable → treat as empty
  }
}

// The single user key. Prefer the canonical `hook_key`; fall back to ANY value in a
// legacy per-memex `keys` map (migration back-compat — an older checkout.json keeps
// working until the next install rewrites it to a single key).
export function keyFromStore(store) {
  if (typeof store?.hook_key === "string") return store.hook_key;
  if (store?.keys && typeof store.keys === "object") {
    const legacy = Object.values(store.keys).find((v) => typeof v === "string");
    if (legacy) return legacy;
  }
  return null;
}

// Whether the stored key is usable for THIS env, i.e. the install/mint can short-circuit
// (issue-3). A key is reusable when one is present AND it was not minted for a DIFFERENT
// api_base. A stored api_base that DIFFERS from the requested one means an env switch
// (e.g. int -> prod): the key must be re-minted, or the MCP/claims go to the new env
// while edits still phone home to the old one with the wrong key (silent 401s). A
// MISSING api_base (legacy store) is treated as same-env so we don't force a needless
// re-mint (and sign-in) on existing installs.
export function hasKeyForEnv(store, apiBase) {
  if (keyFromStore(store) == null) return false;
  return store?.api_base == null || store.api_base === apiBase;
}

// The browser URL the user signs in + confirms the device code on. Mirrors the MCP
// installer (bin/cli.mjs): the admin UI base is the api base minus `/api`.
export function authUrlFor(apiBase, code) {
  return `${apiBase.replace("/api", "")}/install/mcp/auth?code=${code}`;
}

// Mint a user-scoped hook key off a signed-in user token, at the USER-level route
// (no memex in the path, spec-430 dec-3). Raw key returned once.
export async function mintHookKey(apiBase, token, deps = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  const res = await fetchImpl(`${apiBase}/api/hook-keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: "memex checkout hook" }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Failed to mint hook key (${res.status}): ${body}`);
  }
  const json = await res.json();
  if (!json || typeof json.key !== "string") throw new Error("Mint response missing key");
  return json.key;
}

// Persist the single user key, dropping any legacy per-memex map (per-memex dies).
function persist(path, store, apiBase, key, fs) {
  const next = { ...store, api_base: apiBase, hook_key: key };
  delete next.keys; // spec-430 dec-3: never a per-memex map
  fs.mkdirp(join(path, "..")); // ensure ~/.memex
  fs.write(path, JSON.stringify(next, null, 2) + "\n");
}

// Mint + store from an EXISTING signed-in token — NO sign-in. Short-circuits when a key
// is already stored FOR THIS env; an env switch (stored api_base differs) re-mints and
// overwrites (issue-3). Returns { provisioned, key }.
export async function provisionHookKey({ apiBase, token, fs = DEFAULT_FS, deps = {} }) {
  const path = deps.storePath ?? storePath();
  const store = loadStore(path, fs);
  if (hasKeyForEnv(store, apiBase)) return { provisioned: false, key: keyFromStore(store) };
  const key = await mintHookKey(apiBase, token, deps);
  persist(path, store, apiBase, key, fs);
  return { provisioned: true, key };
}

// Standalone: ensure a key exists for THIS env, doing ONE device-flow sign-in if
// absent — or if the stored key was minted for a different env (issue-3). A same-env
// key short-circuits with no sign-in. Returns { provisioned, signedIn, key }.
export async function ensureHookKey({ apiBase, fs = DEFAULT_FS, deps = {} }) {
  const path = deps.storePath ?? storePath();
  const store = loadStore(path, fs);
  if (hasKeyForEnv(store, apiBase)) {
    return { provisioned: false, signedIn: false, key: keyFromStore(store) };
  }

  const { reqId, code } = await startCliAuth(apiBase, deps);
  if (deps.openBrowser) deps.openBrowser(authUrlFor(apiBase, code));
  const token = await pollForToken(apiBase, reqId, deps);
  const key = await mintHookKey(apiBase, token, deps);
  persist(path, store, apiBase, key, fs);
  return { provisioned: true, signedIn: true, key };
}

// The unified install (spec-430 dec-2): ONE device-flow sign-in yields BOTH
// credentials. The caller supplies `plantMcp(token)` to write the MCP entry off the
// SAME mxt_ token; we mint the user-scoped mxh_ hook key off it too. No second
// sign-in. Returns { token, hook }.
export async function unifiedInstall({ apiBase, fs = DEFAULT_FS, deps = {} }) {
  const { reqId, code } = await startCliAuth(apiBase, deps);
  if (deps.openBrowser) deps.openBrowser(authUrlFor(apiBase, code));
  const token = await pollForToken(apiBase, reqId, deps);

  // Both credentials from the SAME token. MCP first (the caller plants it), then the
  // hook key — neither triggers another sign-in.
  if (deps.plantMcp) await deps.plantMcp(token);
  const hook = await provisionHookKey({ apiBase, token, fs, deps });
  return { token, hook };
}
