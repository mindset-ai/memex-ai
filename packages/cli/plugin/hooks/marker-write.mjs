#!/usr/bin/env node
// spec-371 Hook A — the MARKER WRITER. A Claude Code PostToolUse hook matched to
// the Memex claim/advance tool calls. It records (or clears) the local thread→spec
// marker the edit hook reads — the binding that lets an edit be attributed without
// any cross-channel id. Non-blocking; emits nothing; never throws.
//
// This is how the checkout becomes a side effect of acts you already perform: an
// explicit claim_spec, OR any successful spec mutation (edit a section, resolve a
// decision, move a phase — the gate checks it out server-side, dec-11). A rejected
// mutation (the collision takeover) does NOT arm the thread. Watching these tool
// calls (not your prompts) is the whole point — nothing reads what you typed.
import { writeMarker, clearMarker, decideMarkerAction } from "../lib/checkout-marker.js";

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
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

  const d = decideMarkerAction(p);
  if (d.action === "clear") clearMarker(sessionId);
  else if (d.action === "write") writeMarker(sessionId, { memex: d.memex, spec: d.spec });
}

main().catch(() => {}); // a hook must never break the agent
