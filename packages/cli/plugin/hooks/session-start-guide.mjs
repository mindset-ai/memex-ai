#!/usr/bin/env node
// The SessionStart guide — two independent, non-blocking steers folded into one
// additionalContext:
//
//   1. spec-430 dec-4 — self-heal. When the checkout key isn't set up on this
//      machine (no `hook_key` in ~/.memex/checkout.json and no env override), OFFER
//      to finish setup. Emitted ONLY when not set up; silent once set up.
//   2. spec-300 dec-26 — skills attunement (ac-69). Prime Claude Code to reach for
//      Memex Skills across the user's Memexes when a named skill isn't one of its own
//      local skills. Emitted EVERY session — it is gated on nothing (the Memex MCP
//      connection is independent of the checkout key), and mirrors the MCP server's
//      own `## Skills` instruction (std-40: the plugin ENHANCES that baseline, never
//      replaces it; std-41: the hook adds a capability, it doesn't own correctness).
//
// Non-blocking; never errors the session; exits 0. This is also the pre-MCP priming
// layer: the MCP's own instructions can't guide a user before the MCP is connected,
// so the bundled hook closes that gap.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

// Is a usable checkout key present? Env override (CI) or a stored single key, or any
// value in a legacy per-memex map (back-compat) — the key is user-scoped either way.
function isSetUp() {
  if (process.env.MEMEX_CHECKOUT_HOOK_KEY) return true;
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), ".memex", "checkout.json"), "utf8"));
    if (typeof cfg.hook_key === "string" && cfg.hook_key) return true;
    if (cfg.keys && typeof cfg.keys === "object") {
      return Object.values(cfg.keys).some((v) => typeof v === "string" && v);
    }
  } catch {
    /* absent / unreadable → not set up */
  }
  return false;
}

const SETUP_STEER = [
  "Memex spec-checkout is installed but not fully set up on this machine: no checkout",
  "key is present, so in-flow edits to a claimed Spec won't be recorded yet. If the",
  "user wants Memex spec-checkout working, OFFER (don't nag) to finish setup by running",
  "`npx -y memex-ai install` — one browser sign-in that plants the MCP token and mints",
  "the user checkout key. If they decline, stay silent for the rest of the session.",
].join(" ");

// spec-300 dec-26 (ac-69) — mirrors the MCP server's `## Skills` instruction so the
// guidance is present from the very first turn, before any tool call.
const SKILLS_STEER = [
  "Memex hosts reusable Skills across the user's Memexes. If the user asks you to use a",
  "skill by name and it isn't one of your own local skills, don't stop there: call the",
  "Memex MCP tool list_skills with all_memexes:true to find it across every Memex they",
  "can access, then get_skill(ref) and follow it. If the same name lives in more than one",
  "Memex, ask which one — never guess.",
].join(" ");

async function main() {
  await readStdin(); // drain the SessionStart payload; we only need local state
  // Self-heal steer only when not set up; the skills attunement every session.
  const parts = [];
  if (!isSetUp()) parts.push(SETUP_STEER);
  parts.push(SKILLS_STEER);
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: parts.join("\n\n"),
      },
    }),
  );
}

main().catch(() => {});
