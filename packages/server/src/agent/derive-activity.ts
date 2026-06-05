// Pulse (b-60 t-6): read/call activity derivation — SHARED across surfaces.
//
// Both the in-app agent loop (`agent/tools.ts`) and the MCP handler wrap
// (`mcp/tools.ts`) map a non-mutating tool invocation to a single Pulse
// ChangeEvent. spec-156 ac-15 makes the MCP surface emit too, so the mapping
// must be ONE function shared by both — otherwise the two surfaces could drift
// and Pulse would render different narratives for the same tool. The only
// per-surface difference is the event `channel` (`in_app_agent` vs `mcp`),
// which each emitter stamps on after calling `deriveActivity`.
//
// Mutating tools already emit through mutate() inside their service handlers,
// so emitting here too would double-count. We therefore only derive an
// activity for NON-mutating calls:
//   - every `readOnlyHint: true` spec (list_*/get_*/search_memex/code reads),
//   - `assess_spec` for its read modes (phase/narrative/comments) — its
//     `consolidate` mode mutates via mutate(), so we skip it,
//   - `memex__send_slack_message` — an external side-effecting *call* that does
//     not touch the bus via mutate(), so it can't double-emit.
// Anything else returns null and the caller stays silent.

import type { ChangeAction, ChangeEntity } from "../services/bus.js";
import type { ToolSpec } from "./tool-specs.js";

export const SLACK_TOOL = "memex__send_slack_message";

/** Extract a trailing `b-N`/`std-N`/`doc-N`/`dec-N`/`t-N`/`s-N`/`c-N`-style
 *  handle from a canonical ref or a bare handle. Best-effort: returns the last
 *  path segment if it looks like a handle, else undefined. */
export function handleFromRef(ref: unknown): string | undefined {
  if (typeof ref !== "string" || ref.length === 0) return undefined;
  const last = ref.split("/").pop()?.trim();
  if (last && /^[a-z]+-\d+$/i.test(last)) return last;
  return undefined;
}

export interface DerivedActivity {
  action: ChangeAction;
  entity: ChangeEntity;
  narrative: string;
  payload?: Record<string, unknown>;
  /** When false, the bound doc id is NOT attached as the event's docId
   *  (e.g. `query` search events target no single doc — see bus.ts). Defaults
   *  to true. */
  docScoped?: boolean;
}

/** Map a non-mutating tool call to a Pulse activity, or null to stay silent
 *  (mutating tools, which already emit via mutate()). Pure + cheap. Shared by
 *  the in-app agent loop and the MCP handler wrap (spec-156 ac-15). */
export function deriveActivity(
  spec: ToolSpec,
  name: string,
  input: Record<string, unknown>,
): DerivedActivity | null {
  // search_memex → searched
  if (name === "search_memex") {
    const query = typeof input.query === "string" ? input.query : "";
    const target = handleFromRef(input.memex);
    const narrative = target
      ? `searched "${query}" in ${target}`
      : `searched "${query}"`;
    return {
      action: "searched",
      entity: "query",
      narrative,
      payload: { tool: name, query, kind: input.kind, limit: input.limit },
      // A search targets the whole Memex, not the bound doc — no docId per bus.ts.
      docScoped: false,
    };
  }

  // assess_spec → assessed, but only its read modes (consolidate mutates).
  if (name === "assess_spec") {
    const mode = typeof input.mode === "string" ? input.mode : undefined;
    if (mode === "consolidate") return null;
    const target = handleFromRef(input.ref);
    const narrative = target
      ? `assessed ${target}${mode ? ` (${mode})` : ""}`
      : `assessed a Spec${mode ? ` (${mode})` : ""}`;
    return {
      action: "assessed",
      entity: "document",
      narrative,
      payload: { tool: name, mode, target: input.target },
    };
  }

  // Slack send is an external call that doesn't go through mutate().
  if (name === SLACK_TOOL) {
    const to = typeof input.channelOrUser === "string" ? input.channelOrUser : undefined;
    return {
      action: "called",
      entity: "tool_call",
      narrative: to ? `messaged ${to} on Slack` : "sent a Slack message",
      payload: { tool: name, channelOrUser: to },
      docScoped: false,
    };
  }

  // Remaining read-only tools → viewed. Mutating tools (readOnlyHint:false)
  // are skipped — they emit through mutate() already.
  if (!spec.annotations.readOnlyHint) return null;

  const target = handleFromRef(input.ref);
  const narrative = target ? `read ${target}` : `ran ${name}`;
  return {
    action: "viewed",
    // Doc-scoped reads carry a real doc-tree entity; collection/list reads with
    // no single target fall back to the generic tool_call entity.
    entity: target ? "document" : "tool_call",
    narrative,
    payload: { tool: name, ref: input.ref },
  };
}
