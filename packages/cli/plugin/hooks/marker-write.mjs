#!/usr/bin/env node
// spec-371 Hook A — the MARKER WRITER. A Claude Code PostToolUse hook matched to
// the Memex claim/advance tool calls. It records (or clears) the local thread→spec
// marker the edit hook reads — the binding that lets an edit be attributed without
// any cross-channel id. Non-blocking; emits nothing; never throws.
//
// This is how the claim becomes a side effect of acts you already perform: an
// explicit claim_spec, or an implicit checkout when update_doc advances a spec
// into build/verify. Watching these tool calls (not your prompts) is the whole
// point — nothing reads what you typed.
import { writeMarker, clearMarker, parseSpecRef } from "../lib/checkout-marker.js";

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

// Advancing INTO build (or onward to verify) is the implicit checkout; drafting or
// closing is not — so only those statuses bind from an update_doc.
function isBuildwardStatus(status) {
  return status === "build" || status === "verify";
}

async function main() {
  let p;
  try {
    p = JSON.parse(await readStdin());
  } catch {
    return;
  }
  const sessionId = p?.session_id;
  const toolName = p?.tool_name;
  const input = p?.tool_input ?? {};
  if (!sessionId || typeof toolName !== "string") return;

  if (toolName.endsWith("unclaim_spec")) {
    clearMarker(sessionId);
    return;
  }
  // update_doc only binds when it advances the spec buildward (implicit checkout).
  if (toolName.endsWith("update_doc") && !isBuildwardStatus(input.status)) return;

  const parsed = parseSpecRef(input.ref);
  if (parsed) writeMarker(sessionId, { memex: parsed.memex, spec: parsed.spec });
}

main().catch(() => {}); // a hook must never break the agent
