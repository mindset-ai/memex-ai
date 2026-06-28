#!/usr/bin/env node
// spec-371 Hook B — the EDIT PHONE-HOME. A Claude Code PostToolUse hook matched to
// file edits. It consults the local marker (the privacy gate, dec-2): only when
// this thread is checked out does anything leave the machine. NOT checked out →
// silence, no nudge (dec-8 rework). Non-blocking; never throws.
//
// What it ever sends: changed file paths + the checked-out spec ref + the git
// commit/branch + the conversation UID. Never source code, never your prompts.
import { decideEditAction } from "../lib/checkout-marker.js";
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

// Where the bootstrap stored { api_base, keys: { "<ns>/<memex>": "mxh_…" } } — keyed
// per memex (dec-10). Env vars override (CI); a legacy single `hook_key` still works.
// Resolves the key for the CLAIMED memex so a multi-memex user phones each home with
// the right scoped credential.
function loadConfig(memexRef) {
  const envBase = process.env.MEMEX_CHECKOUT_API_BASE;
  const envKey = process.env.MEMEX_CHECKOUT_HOOK_KEY;
  if (envBase && envKey) return { apiBase: envBase, hookKey: envKey };
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), ".memex", "checkout.json"), "utf8"));
    const apiBase = typeof cfg.api_base === "string" ? cfg.api_base : envBase;
    const perMemex =
      cfg.keys && memexRef && typeof cfg.keys[memexRef] === "string" ? cfg.keys[memexRef] : null;
    const hookKey = perMemex ?? (typeof cfg.hook_key === "string" ? cfg.hook_key : null);
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
  if (decision.action !== "phone-home") return; // not checked out → silent, no nudge
  // 'phone-home': this thread is checked out → report the edit.
  const cfg = loadConfig(decision.claim.memex);
  if (!cfg) return; // no key planted → fail quiet, nothing leaves
  const paths = changedPaths(p);
  if (paths.length === 0) return;
  const cwd = p.cwd || process.cwd();
  await phoneHome(cfg, {
    ref: decision.claim.ref,
    thread_uid: sessionId,
    changed_paths: paths,
    commit_sha: gitOut(cwd, ["rev-parse", "HEAD"]),
    branch: gitOut(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
  });
}

main().catch(() => {});
