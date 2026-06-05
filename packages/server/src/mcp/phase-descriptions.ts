// b-33 t-5 / b-68 t-7: per-phase MCP tool-description override plumbing.
//
// The agent eventually wants different tool descriptions in different Spec
// phases (e.g. discourage `create_task` while a Spec is in `plan`, expand
// `update_doc` guidance in `verify`). Until b-68 t-7 those overrides were
// stored as `agent/phases/<phase>/mcp-descriptions.md` files. Those files
// are now retired — their content (currently all inert HTML-comment stubs)
// is captured as `target: { phase }` GuidanceBlock records in
// `BASE_SCAFFOLD.baseGuidance`. When per-phase tool description overrides
// land, they'll arrive as scaffold data (base or Org) rather than
// loose markdown.
//
// `parsePhaseDescriptions` stays exported because phase-assessment.ts uses
// the same `## tool_name → body` parser to shard `_base/code-grounding.md`
// — that file is a single document with `## prompt` / `## nudge:*`
// sections, completely separate from the retired mcp-descriptions surface.
//
// Hook point: today the MCP server is constructed per-request in `app.ts`
// without per-request phase context (the user → memex → spec link isn't
// resolved at server-init time — the agent picks the spec inside a tool
// call). So `applyPhaseDescriptionOverrides` is invoked at registration
// with `phase: undefined` and is a passthrough. When per-request phase
// plumbing lands (future Spec follow-up), pass the resolved phase here
// and any future overrides will start taking effect.

import type { SpecPhase } from "@memex/shared";
import type { ToolSpec } from "../agent/tool-specs.js";

// ──────────────────────────────────────────────
// Parser
// ──────────────────────────────────────────────

/**
 * Parse a `mcp-descriptions.md` shard into a map of `{toolName: overrideText}`.
 *
 * Format:
 *   - `## tool_name` lines start a new override block.
 *   - Everything between one `## ` header and the next (or EOF) is the body,
 *     trimmed.
 *   - HTML comments (`<!-- ... -->`) at top level are stripped before parsing.
 *   - Whitespace-only / empty input → `{}`.
 *
 * Intentionally minimal — no frontmatter, no nested headers, no escapes. If
 * the format grows, prefer a separate `mcp-descriptions.yaml` over inventing
 * markdown extensions.
 */
export function parsePhaseDescriptions(markdown: string): Record<string, string> {
  // Strip top-level HTML comments. `[\s\S]` so the regex handles multi-line
  // comments; non-greedy so adjacent comments don't get glommed together.
  const stripped = markdown.replace(/<!--[\s\S]*?-->/g, "");
  const lines = stripped.split(/\r?\n/);

  const out: Record<string, string> = {};
  let currentName: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (currentName === null) return;
    const body = buffer.join("\n").trim();
    // Skip empty bodies — an `## tool` with no content is a structural
    // artefact (placeholder header someone left behind), not an override.
    if (body.length > 0) {
      out[currentName] = body;
    }
    currentName = null;
    buffer = [];
  };

  for (const line of lines) {
    const headerMatch = line.match(/^##\s+(.+?)\s*$/);
    if (headerMatch) {
      flush();
      currentName = headerMatch[1].trim();
      continue;
    }
    if (currentName !== null) {
      buffer.push(line);
    }
    // Lines outside any `## ` header (top-level prose, blank lines) are
    // ignored — the file is keyed entirely by tool-name headers.
  }
  flush();

  return out;
}

// ──────────────────────────────────────────────
// Per-phase override map
// ──────────────────────────────────────────────

/**
 * Per-phase override map.
 *
 * b-68 t-7: previously parsed from `agent/phases/<phase>/mcp-descriptions.md`
 * at module init; those files (all HTML-comment stubs) have been retired in
 * favour of `target: { phase }` GuidanceBlock records on
 * `BASE_SCAFFOLD.baseGuidance`. No live overrides exist on either surface
 * today (the comment-only stubs parsed to `{}`), so the map collapses to an
 * empty record per phase — same shape, same semantics. When per-phase
 * description overrides actually land, they will be sourced from
 * BASE_SCAFFOLD via a `toToolDefinition`-style projection rather than
 * re-parsed from markdown.
 *
 * `draft` and `plan` share the same override set (the two phases are
 * functionally identical for the agent; mirrors the folder mapping in
 * `agent/system-prompt.ts`).
 */
export const PHASE_DESCRIPTIONS: Record<SpecPhase, Record<string, string>> = {
  draft: {},
  plan: {},
  build: {},
  verify: {},
  done: {},
};

// ──────────────────────────────────────────────
// Merge
// ──────────────────────────────────────────────

/**
 * Return a new ToolSpec[] with each tool's description replaced when an
 * override is present in `overrides`. Tools not named in `overrides` pass
 * through unchanged. Overrides naming non-existent tools are ignored
 * (forwards-compat: a future override file mentioning a removed tool
 * shouldn't crash the server).
 *
 * Pure / non-mutating: callers can hold onto the input array unchanged.
 */
export function mergeDescriptions(
  baseTools: ToolSpec[],
  overrides: Record<string, string>,
): ToolSpec[] {
  return baseTools.map((spec) => {
    const replacement = overrides[spec.name];
    if (replacement === undefined) return spec;
    return { ...spec, description: replacement };
  });
}

/**
 * Convenience wrapper for the MCP registration site (`mcp/tools.ts`):
 * given a phase (or `undefined`), return the merged tool catalogue.
 *
 * `phase: undefined` → passthrough (no overrides applied). The MCP server
 * is constructed per-request in `app.ts` without a known Spec / phase
 * (the spec is selected by the agent inside a tool call, not at server
 * init), so the current call site passes `undefined` and behaviour is
 * unchanged. When per-request phase plumbing lands, pass the resolved
 * phase here and the existing `phases/<phase>/mcp-descriptions.md` stubs
 * will start taking effect with no other code changes.
 */
export function applyPhaseDescriptionOverrides(
  baseTools: ToolSpec[],
  phase: SpecPhase | undefined,
): ToolSpec[] {
  if (phase === undefined) return baseTools;
  return mergeDescriptions(baseTools, PHASE_DESCRIPTIONS[phase]);
}
