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

// The task-sync STEER cadence (spec-371). 0 = nag after EVERY edit (the v1 "simple
// stick"). This is the single knob: raise it (e.g. 5 * 60 * 1000 for once-per-5min)
// to throttle the nag with NO other code change — decideEditSteer reads it and the
// per-session `lastNagAt` clock stamped in the marker enforces it.
export const NAG_MIN_INTERVAL_MS = 0;

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
// actively-built spec never expires mid-session (dec-4). PRESERVES the lastNagAt
// clock — activity refreshes the TTL but must not reset the steer's rate limiter.
export function touchMarker(sessionId, opts = {}) {
  const m = readMarker(sessionId, opts);
  if (!m) return null;
  const ts = opts.now ?? Date.now();
  const next = { memex: m.memex, spec: m.spec, ts };
  if (typeof m.lastNagAt === "number") next.lastNagAt = m.lastNagAt;
  mkdirSync(checkoutDir(opts), { recursive: true });
  writeFileSync(markerPathFor(sessionId, opts), JSON.stringify(next), "utf8");
  return next;
}

// Stamp the task-sync steer clock (lastNagAt) for this session, preserving the
// claim + activity ts. Called when decideEditSteer decides to nag, so the
// NAG_MIN_INTERVAL_MS throttle has a per-session "last fired" to measure against.
export function stampNag(sessionId, opts = {}) {
  const m = readMarker(sessionId, opts);
  if (!m) return null;
  const next = { memex: m.memex, spec: m.spec, ts: m.ts, lastNagAt: opts.now ?? Date.now() };
  mkdirSync(checkoutDir(opts), { recursive: true });
  writeFileSync(markerPathFor(sessionId, opts), JSON.stringify(next), "utf8");
  return next;
}

// The active claim for a session, or null when there is none OR it has expired.
export function resolveActiveClaim(sessionId, opts = {}) {
  const m = readMarker(sessionId, opts);
  if (!m) return null;
  if (isExpired(m, opts.ttlMs ?? DEFAULT_TTL_MS, opts.now ?? Date.now())) return null;
  return { memex: m.memex, spec: m.spec, ref: `${m.memex}/specs/${m.spec}` };
}

// Decide what the EDIT hook should do for PHONE-HOME, given the session's marker
// state. The privacy gate (dec-2): only a fresh checkout marker lets anything leave
// the machine.
//   - 'phone-home' : checked out (fresh marker) -> report the edit, refresh the TTL.
//   - 'silent'     : NOT checked out -> do nothing, NO network call.
// The crucial invariant (ac-2 / ac-16): only 'phone-home' ever leaves the machine,
// and a thread that isn't a Memex thread is simply silent. The task-sync STEER is a
// SEPARATE, additive layer (decideEditSteer) the hook applies on top, gated on the
// SAME checkout marker, so it too is silent on a non-Memex thread.
export function decideEditAction(sessionId, opts = {}) {
  const claim = resolveActiveClaim(sessionId, opts);
  if (claim) {
    touchMarker(sessionId, opts); // refresh TTL on activity (preserves lastNagAt)
    return { action: "phone-home", claim };
  }
  return { action: "silent" };
}

// The task-sync STEER text (spec-371). A short, CONDITIONAL nudge: it asks for a task
// state change ONLY when the edit is a state transition, and explicitly licenses doing
// nothing on a mid-task edit, so a task that legitimately spans many edits is never
// updated prematurely. Kept plain (no em dashes / arrows) for the model's reminder.
export function nagText(spec) {
  return (
    `${spec} is checked out in this session. Keep Memex in sync with what this edit means: ` +
    `if it COMPLETED a task, mark that task done with update_task; ` +
    `if it STARTED a task you have picked up, mark that task in progress; ` +
    `if it began work that no task covers yet, create the task with create_task. ` +
    `If it is just a mid-task edit, no update is needed: keep going.`
  );
}

// The task-sync STEER decision (spec-371): on an edit in a CHECKED-OUT session, decide
// whether to nudge the agent to reflect task STATE in Memex. Gated on the checkout
// marker (nothing is surfaced on a non-Memex thread, dec-2) and rate-limited by
// NAG_MIN_INTERVAL_MS via the per-session lastNagAt clock. Stamps the clock when it
// fires. Returns { nag: false } or { nag: true, text }.
export function decideEditSteer(sessionId, opts = {}) {
  const claim = resolveActiveClaim(sessionId, opts);
  if (!claim) return { nag: false }; // not checked out -> no steer (privacy gate, dec-2)
  const now = opts.now ?? Date.now();
  const interval = opts.nagIntervalMs ?? NAG_MIN_INTERVAL_MS;
  const m = readMarker(sessionId, opts);
  const last = typeof m?.lastNagAt === "number" ? m.lastNagAt : 0;
  if (last && now - last < interval) return { nag: false }; // throttled by the cadence knob
  stampNag(sessionId, opts);
  return { nag: true, text: nagText(claim.spec) };
}

// Parse a Memex MCP tool_input `ref` into { memex: "ns/slug", spec: "spec-N", ref }
// when it names a spec (directly OR via any sub-entity — section/decision/task/ac
// refs all carry .../specs/spec-N/...), else null. The (memex, spec) the marker is
// keyed on. No VCS state is consulted anywhere in this module.
export function parseSpecRef(ref) {
  if (typeof ref !== "string") return null;
  const parts = ref.split("/");
  if (parts.length < 4 || parts[2] !== "specs") return null;
  return { memex: `${parts[0]}/${parts[1]}`, spec: parts[3], ref };
}

// The spec-mutating MCP tools whose SUCCESS implicitly checks out the spec for this
// thread — mirrors the server gate (services/checkout-gate.ts GATED_SPEC_TOOLS) plus
// the explicit claim_spec. A successful call to any of these ARMS the thread (writes
// the marker); unclaim_spec disarms it; everything else (reads, a collision-fail)
// leaves the marker untouched (dec-11, ac-9).
export const ARMING_TOOLS = new Set([
  "claim_spec",
  "update_doc",
  "update_section", "add_section", "retitle_section", "delete_section",
  "create_decision", "update_decision", "resolve_decision", "delete_decision",
  "approve_candidate", "reject_candidate",
  "add_clause", "edit_clause", "delete_clause",
  "create_task", "update_task", "delete_task",
  "create_ac", "update_ac", "delete_ac", "link_ac_to_decision",
  "write_qa_report", "ground_spec",
]);

// True when the PostToolUse payload shows the tool call FAILED — so a rejected
// mutation (notably the gate's collision-takeover error) does NOT arm the thread
// (ac-9). Defensive across payload shapes: an MCP error result sets isError, and
// the gate's message carries a stable sentinel.
function toolCallFailed(payload) {
  const r = payload?.tool_response;
  if (r && typeof r === "object" && (r.isError === true || r.is_error === true)) return true;
  const text = typeof r === "string" ? r : JSON.stringify(r ?? "");
  return text.includes("call claim_spec({"); // the collision-takeover sentinel
}

// Decide the marker action for a PostToolUse payload on a Memex MCP tool:
//   { action: 'clear' }              — unclaim_spec
//   { action: 'write', memex, spec } — an arming tool that SUCCEEDED on a spec
//   { action: 'skip' }               — reads, failures, non-spec refs
// The caller keys the marker on payload.session_id (the conversation UID).
export function decideMarkerAction(payload) {
  const toolName = typeof payload?.tool_name === "string" ? payload.tool_name : "";
  // Strip the MCP server prefix down to the bare tool name. The Memex server is
  // exposed as `mcp__memex__<tool>` when configured directly, but as
  // `mcp__plugin_<plugin>_memex__<tool>` when the SAME server ships inside this
  // plugin (Claude Code namespaces a plugin's MCP servers). Accept both, or the
  // gate silently no-ops on every real plugin install.
  const bare = toolName.replace(/^mcp__(?:plugin_[a-z0-9-]+_)?memex__/, "");
  if (bare === "unclaim_spec") return { action: "clear" };
  if (!ARMING_TOOLS.has(bare)) return { action: "skip" };
  if (toolCallFailed(payload)) return { action: "skip" };
  const parsed = parseSpecRef((payload?.tool_input ?? {}).ref);
  if (!parsed) return { action: "skip" };
  return { action: "write", memex: parsed.memex, spec: parsed.spec };
}
