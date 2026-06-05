import type {
  MessageParam,
  ContentBlockParam,
} from "@anthropic-ai/sdk/resources/messages.js";

/**
 * Strip `tool_use` blocks that have no matching `tool_result` in the immediately
 * following user message.
 *
 * Anthropic's API enforces that every `tool_use` block must have a corresponding
 * `tool_result` block in the *next* message. That contract holds inside the agent
 * loop (the React UI's LangGraph executes tools then sends results back), but it
 * breaks in two scenarios where a user re-enters the conversation mid-flight:
 *
 *   1. The agent emitted an interactive UI tool (e.g. `render_confirmation`),
 *      SSE closed, and the user typed a fresh question instead of clicking the
 *      widget. The history now contains
 *        [..., assistant(tool_use: x), user(text: "...")]
 *      with no `tool_result` for `x` — Anthropic rejects with 400.
 *   2. Reloading prior conversation history on a non-resume request can land us
 *      on the same shape if the last turn ended with a pending UI tool.
 *
 * The fix is to drop the orphaned `tool_use` blocks from the assistant turn so
 * the request validates; any leading text in that turn is preserved. We do NOT
 * synthesise fake `tool_result` blocks because the agent shouldn't see fabricated
 * outcomes for tools it actually never ran — silently dropping the call is the
 * smaller lie.
 *
 * This is intentionally a single function used by both `/chat` and `/chat/create`
 * — both endpoints proxy to Anthropic directly and have the same exposure.
 */
export function stripDanglingToolUses(
  messages: MessageParam[],
): MessageParam[] {
  if (messages.length === 0) return messages;

  return messages.map((msg, i) => {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) return msg;

    const blocks = msg.content as ContentBlockParam[];
    const toolUseIds = new Set<string>();
    for (const b of blocks) {
      if (b.type === "tool_use") toolUseIds.add(b.id);
    }
    if (toolUseIds.size === 0) return msg;

    // Collect the tool_use ids that ARE answered in the very next user message.
    // Anthropic requires the result blocks immediately after — gaps don't count.
    const next = messages[i + 1];
    const answered = new Set<string>();
    if (next && next.role === "user" && Array.isArray(next.content)) {
      for (const b of next.content as ContentBlockParam[]) {
        if (b.type === "tool_result") answered.add(b.tool_use_id);
      }
    }

    const allAnswered = [...toolUseIds].every((id) => answered.has(id));
    if (allAnswered) return msg;

    // At least one tool_use is dangling — strip every tool_use block from this
    // assistant turn. We strip all of them rather than picking the unanswered
    // subset to keep the round-trip well-formed: a half-answered turn (some
    // results present, some tool_use blocks gone) would still fail validation.
    const filtered = blocks.filter((b) => b.type !== "tool_use");

    // If stripping left no content, replace with a placeholder text block so
    // the assistant message stays non-empty (Anthropic rejects empty content).
    if (filtered.length === 0) {
      return {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "(continued)" }],
      };
    }

    return { role: "assistant" as const, content: filtered };
  });
}
