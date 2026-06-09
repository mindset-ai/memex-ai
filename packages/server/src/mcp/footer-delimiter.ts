// spec-203 dec-3: the ONE source of truth for the in-chat footer boundary.
//
// The footer (platform-injected phase guidance / handoff / nudges) rides inside
// the single MCP `content[0].text` blob — there is no separate transport field.
// This delimiter marks where the tool's real output ends and the platform footer
// begins, so the footer is machine-separable (for the audit trail) and visibly
// labelled (for the agent).
//
// It is deliberately ONE knob. If the labelled banner ever provokes adverse agent
// behaviour, revert it to a minimal marker (e.g. `"---"` or `"_____"`) HERE and
// nothing else changes: `formatFullDocState` emits this exact string at the
// boundary, and the audit split (`splitToolResult`) reads the same constant.
export const FOOTER_DELIMITER =
  "##### MEMEX FOOTER · platform guidance, not tool output #####";

/**
 * Split a tool-result string at the footer boundary. Returns the tool's real
 * output (`body`) and the platform footer (`footer` — everything after the first
 * delimiter, leading whitespace trimmed). `footer` is `null` when no delimiter is
 * present, i.e. no footer was injected (non-Spec docs, terse responses). The
 * first occurrence wins; the labelled delimiter is collision-proof against real
 * document content by construction.
 */
export function splitToolResult(result: string): {
  body: string;
  footer: string | null;
} {
  const idx = result.indexOf(FOOTER_DELIMITER);
  if (idx === -1) return { body: result, footer: null };
  return {
    body: result.slice(0, idx),
    footer: result.slice(idx + FOOTER_DELIMITER.length).replace(/^\s+/, ""),
  };
}
