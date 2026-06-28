// spec-371: the client-side CHECKOUT MARKER — the local, on-machine binding
// between a coding-agent thread (its hook session id) and a (memex, spec). This
// is the privacy gate's source of truth (dec-1/dec-2): the edit hook phones home
// ONLY when a FRESH marker says this thread is claimed, so an unclaimed / non-
// Memex thread never makes a network call. Nothing about the host VCS is read.
//
// Zero-dependency plain ESM so the planted Claude Code hooks can import it
// directly on the user's machine (it sits at <plugin-root>/lib beside the hooks).
// Every filesystem root is injectable so the logic is unit-testable without
// touching a real home directory.

import { homedir } from "node:os";
import { join } from "node:path";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";

// The inactivity TTL: a marker older than this is treated as released (dec-4), so
// an abandoned session can't re-attribute edits days later. Refreshed on every
// edit that phones home.
export const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000; // 8h of inactivity

// Default checkout dir: ~/.memex/checkouts. A claim's marker is <session_id>.json;
// the once-per-session "you haven't claimed" nudge leaves a <session_id>.nudged
// sentinel beside it. `opts.dir` / `opts.home` override for tests.
export function checkoutDir(opts = {}) {
  if (opts.dir) return opts.dir;
  return join(opts.home ?? homedir(), ".memex", "checkouts");
}

function sanitise(sessionId) {
  // session ids are uuids in practice; defend against path traversal anyway.
  return String(sessionId).replace(/[^A-Za-z0-9._-]/g, "_");
}

export function markerPathFor(sessionId, opts = {}) {
  return join(checkoutDir(opts), `${sanitise(sessionId)}.json`);
}

function nudgeSentinelPath(sessionId, opts = {}) {
  return join(checkoutDir(opts), `${sanitise(sessionId)}.nudged`);
}

function clearNudge(sessionId, opts = {}) {
  rmSync(nudgeSentinelPath(sessionId, opts), { force: true });
}

// Write / overwrite the marker for a session — the explicit-or-implicit claim
// (dec-1). A new claim SUPERSEDES the prior one (dec-4) because it overwrites.
export function writeMarker(sessionId, { memex, spec }, opts = {}) {
  const dir = checkoutDir(opts);
  mkdirSync(dir, { recursive: true });
  const ts = opts.now ?? Date.now();
  writeFileSync(markerPathFor(sessionId, opts), JSON.stringify({ memex, spec, ts }), "utf8");
  // A fresh claim resets the once-per-session nudge — its purpose is served.
  clearNudge(sessionId, opts);
  return { memex, spec, ts };
}

export function readMarker(sessionId, opts = {}) {
  const p = markerPathFor(sessionId, opts);
  if (!existsSync(p)) return null;
  try {
    const m = JSON.parse(readFileSync(p, "utf8"));
    if (
      m &&
      typeof m.memex === "string" &&
      typeof m.spec === "string" &&
      typeof m.ts === "number"
    ) {
      return m;
    }
    return null;
  } catch {
    return null;
  }
}

export function clearMarker(sessionId, opts = {}) {
  rmSync(markerPathFor(sessionId, opts), { force: true });
}

export function isExpired(marker, ttlMs = DEFAULT_TTL_MS, now = Date.now()) {
  if (!marker || typeof marker.ts !== "number") return true;
  return now - marker.ts > ttlMs;
}

// Refresh a live marker's timestamp (called on each phoned-home edit) so an
// actively-built spec never expires mid-session (dec-4).
export function touchMarker(sessionId, opts = {}) {
  const m = readMarker(sessionId, opts);
  if (!m) return null;
  return writeMarker(sessionId, { memex: m.memex, spec: m.spec }, opts);
}

// The active claim for a session, or null when there is none OR it has expired.
export function resolveActiveClaim(sessionId, opts = {}) {
  const m = readMarker(sessionId, opts);
  if (!m) return null;
  if (isExpired(m, opts.ttlMs ?? DEFAULT_TTL_MS, opts.now ?? Date.now())) return null;
  return { memex: m.memex, spec: m.spec, ref: `${m.memex}/specs/${m.spec}` };
}

// Decide what the EDIT hook should do, given the session's marker state. This is
// the privacy gate (dec-2) + the speak-only-on-change nudge (dec-8) as PURE logic:
//   - 'phone-home' : claimed (fresh marker) → report the edit, refresh the TTL.
//   - 'nudge'      : unclaimed AND not yet nudged this session → emit ONE nudge,
//                    write the sentinel. NO network call.
//   - 'silent'     : unclaimed AND already nudged → do nothing, NO network call.
// The crucial invariant (ac-2 / ac-5): ONLY 'phone-home' ever leaves the machine.
export function decideEditAction(sessionId, opts = {}) {
  const claim = resolveActiveClaim(sessionId, opts);
  if (claim) {
    touchMarker(sessionId, opts); // refresh TTL on activity
    return { action: "phone-home", claim };
  }
  const sentinel = nudgeSentinelPath(sessionId, opts);
  if (existsSync(sentinel)) return { action: "silent" };
  mkdirSync(checkoutDir(opts), { recursive: true });
  writeFileSync(sentinel, String(opts.now ?? Date.now()), "utf8");
  return { action: "nudge" };
}

// Parse a Memex MCP tool_input `ref` into { memex: "ns/slug", spec: "spec-N", ref }
// when it is a spec ref, else null. The (memex, spec) the marker is keyed on. No
// VCS state is consulted anywhere in this module.
export function parseSpecRef(ref) {
  if (typeof ref !== "string") return null;
  const parts = ref.split("/");
  if (parts.length < 4 || parts[2] !== "specs") return null;
  return { memex: `${parts[0]}/${parts[1]}`, spec: parts[3], ref };
}
