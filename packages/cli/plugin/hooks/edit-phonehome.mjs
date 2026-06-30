#!/usr/bin/env node
// spec-371 Hook B: the EDIT hook. A Claude Code PostToolUse hook matched to file
// edits. It consults the local marker (the privacy gate, dec-2): only when this
// thread is CHECKED OUT does it (1) phone home to RECORD the edit and (2) STEER,
// surfacing a short task-sync reminder to the model via additionalContext. NOT
// checked out means fully silent: no network, no steer. Non-blocking; exits 0.
//
// What it ever sends over the network: changed file paths + the checked-out spec
// ref + git commit/branch + the conversation UID. Never source code, never prompts.
// The steer is emitted LOCALLY on stdout, independent of the network call.
import { decideEditAction, decideEditSteer } from "../lib/checkout-marker.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

// Where the bootstrap stored { api_base, hook_key: "mxh_…" } — ONE user key (spec-430
// dec-1/dec-3), used for EVERY memex. Env vars override (CI). A legacy per-memex
// `keys` map is still honoured on read (migration back-compat) — any key in it works,
// since the key is user-scoped regardless of which memex it was once filed under.
function loadConfig() {
  const envBase = process.env.MEMEX_CHECKOUT_API_BASE;
  const envKey = process.env.MEMEX_CHECKOUT_HOOK_KEY;
  if (envBase && envKey) return { apiBase: envBase, hookKey: envKey };
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), ".memex", "checkout.json"), "utf8"));
    const apiBase = typeof cfg.api_base === "string" ? cfg.api_base : envBase;
    let hookKey = typeof cfg.hook_key === "string" ? cfg.hook_key : null;
    if (!hookKey && cfg.keys && typeof cfg.keys === "object") {
      hookKey = Object.values(cfg.keys).find((v) => typeof v === "string") ?? null;
    }
    if (apiBase && hookKey) return { apiBase, hookKey };
  } catch {
    /* not installed / unreadable → fail quiet */
  }
  return null;
}

function changedPaths(p) {
  const ti = p?.tool_input ?? {};
  return typeof ti.file_path === "string" ? [ti.file_path] : [];
}

function gitOut(cwd, args) {
  try {
    return (
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch {
    return null; // no git / not a repo → omit (portable, std-22)
  }
}

async function phoneHome(cfg, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000); // deterministic; hard 4s cap
  try {
    await fetch(`${cfg.apiBase}/api/spec-checkout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.hookKey}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch {
    /* telemetry must never break the agent — swallow */
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  let p;
  try {
    p = JSON.parse(await readStdin());
  } catch {
    return;
  }
  const sessionId = p?.session_id;
  if (!sessionId) return;

  const decision = decideEditAction(sessionId);
  if (decision.action !== "phone-home") return; // not checked out → silent: no network, no steer
  const paths = changedPaths(p);
  if (paths.length === 0) return; // no file actually changed → nothing to report or steer

  // (1) RECORD the edit (network). Best-effort; skipped silently if no key is planted.
  const cfg = loadConfig();
  if (cfg) {
    const cwd = p.cwd || process.cwd();
    await phoneHome(cfg, {
      ref: decision.claim.ref,
      thread_uid: sessionId,
      changed_paths: paths,
      commit_sha: gitOut(cwd, ["rev-parse", "HEAD"]),
      branch: gitOut(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    });
  }

  // (2) STEER (spec-371): nudge the agent to keep task STATE in sync in Memex. Gated on
  // the SAME checkout marker, rate-limited by NAG_MIN_INTERVAL_MS. Surfaced to the model
  // as a PostToolUse system reminder (additionalContext) on its next turn — non-blocking,
  // not a user-facing chat message. Last stdout write; the process then exits 0.
  const steer = decideEditSteer(sessionId);
  if (steer.nag) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: steer.text },
      }),
    );
  }
}

main().catch(() => {});
