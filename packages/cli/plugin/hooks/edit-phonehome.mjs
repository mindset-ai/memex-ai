#!/usr/bin/env node
// spec-371 Hook B — the EDIT PHONE-HOME. A Claude Code PostToolUse hook matched to
// file edits. It consults the local marker (the privacy gate, dec-2): only when
// this thread holds a FRESH claim does anything leave the machine. Unclaimed → ONE
// in-context nudge to claim, then silence. Non-blocking; never throws.
//
// What it ever sends: changed file paths + the claimed spec ref + the git
// commit/branch. Never source code, never your prompts.
import { decideEditAction } from "../lib/checkout-marker.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const NUDGE =
  "You're editing files but no Memex spec is checked out for this thread. If this " +
  "is work on a spec, call claim_spec to bind it — your edits get attributed and " +
  "teammates see you're on it. If it's not Memex work, ignore this; nothing is sent.";

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

// Where the installer planted { api_base, hook_key }. Env vars override (CI).
function loadConfig() {
  const apiBase = process.env.MEMEX_CHECKOUT_API_BASE;
  const hookKey = process.env.MEMEX_CHECKOUT_HOOK_KEY;
  if (apiBase && hookKey) return { apiBase, hookKey };
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), ".memex", "checkout.json"), "utf8"));
    if (cfg && typeof cfg.api_base === "string" && typeof cfg.hook_key === "string") {
      return { apiBase: cfg.api_base, hookKey: cfg.hook_key };
    }
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

function emitNudge() {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: NUDGE },
    }),
  );
}

async function phoneHome(cfg, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000); // deterministic; hard 4s cap
  try {
    await fetch(`${cfg.apiBase}/api/spec-checkout/edit`, {
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
  if (decision.action === "silent") return;
  if (decision.action === "nudge") {
    emitNudge();
    return;
  }
  // 'phone-home': this thread holds a fresh claim → report the edit.
  const cfg = loadConfig();
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
