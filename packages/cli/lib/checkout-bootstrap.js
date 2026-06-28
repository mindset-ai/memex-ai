// lib/checkout-bootstrap.js — spec-371 first-run credential bootstrap (dec-10).
//
// ONE Memex device-flow sign-in mints the scoped mxh_ hook key and stores it where
// the edit hook reads it — the user never copies a key off the web UI. Idempotent:
// a valid stored key for the memex short-circuits with NO sign-in. All IO (fetch,
// browser, clock, store) is injected so the orchestration unit-tests with no
// network, no browser, and no real HOME. The same device-flow the MCP installer
// uses (auth-flow.js) backs it, so it is the one proper sign-in that binds the
// install to a signed-in Memex user; the mint route is membership-gated.

import { startCliAuth, pollForToken } from "./auth-flow.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

// The store the edit hook reads: ~/.memex/checkout.json. Per-memex keys live under
// `keys["<ns>/<memex>"]`; a legacy single `hook_key` is still honoured on read.
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

// The hook key for a memex: the per-memex map (current format) with a legacy
// single-key fallback (so an older ~/.memex/checkout.json still works).
export function keyForMemex(store, memexRef) {
  if (store?.keys && typeof store.keys[memexRef] === "string") return store.keys[memexRef];
  if (typeof store?.hook_key === "string") return store.hook_key;
  return null;
}

// The browser URL the user opens to sign in + confirm the device code. Mirrors the
// MCP installer (bin/cli.mjs): the admin UI base is the api base minus `/api`.
export function authUrlFor(apiBase, code) {
  return `${apiBase.replace("/api", "")}/install/mcp/auth?code=${code}`;
}

// Mint a scoped hook key off a signed-in user token, via the membership-gated route
// (so the key is inherently bound to the signed-in user's memex). Raw key once.
export async function mintHookKey(apiBase, namespace, memex, token, deps = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  const res = await fetchImpl(`${apiBase}/api/${namespace}/${memex}/hook-keys`, {
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

// Ensure a scoped hook key exists for `memexRef` ("<ns>/<memex>"), minting one off a
// SINGLE device-flow sign-in if absent (dec-10). Returns { provisioned, signedIn,
// memex, key }:
//   stored key present → { provisioned:false, signedIn:false }  — NO sign-in (idempotent)
//   absent → device-flow ONCE → mint → store → { provisioned:true, signedIn:true }
export async function ensureHookKey({ apiBase, memexRef, fs = DEFAULT_FS, deps = {} }) {
  const path = deps.storePath ?? storePath();
  const store = loadStore(path, fs);

  const existing = keyForMemex(store, memexRef);
  if (existing) {
    return { provisioned: false, signedIn: false, memex: memexRef, key: existing };
  }

  // No stored key → exactly one sign-in: claim a device code, open the browser to
  // the Memex confirm page, long-poll for the user token.
  const { reqId, code } = await startCliAuth(apiBase, deps);
  if (deps.openBrowser) deps.openBrowser(authUrlFor(apiBase, code));
  const token = await pollForToken(apiBase, reqId, deps);

  const slash = memexRef.indexOf("/");
  const namespace = memexRef.slice(0, slash);
  const memex = memexRef.slice(slash + 1);
  const key = await mintHookKey(apiBase, namespace, memex, token, deps);

  const next = {
    ...store,
    api_base: apiBase,
    keys: { ...(store.keys ?? {}), [memexRef]: key },
  };
  fs.mkdirp(join(path, "..")); // ensure ~/.memex
  fs.write(path, JSON.stringify(next, null, 2) + "\n");
  return { provisioned: true, signedIn: true, memex: memexRef, key };
}
