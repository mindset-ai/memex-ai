/**
 * Anthropic-compatible message types for client-side use.
 * These mirror the Anthropic API format but don't require the SDK.
 */

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface MessageParam {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

/** Events from the LLM proxy SSE stream */
export type LlmProxyEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'message_complete'; content: ContentBlock[]; stopReason: string | null }
  | { type: 'error'; message: string };

/**
 * Spec lifecycle phase. Mirrors the server's `SpecPhase` in
 * `packages/server/src/mcp/formatters.ts`. The React UI's LangGraph routes to
 * a per-phase agent node so future phase-specific behaviour can diverge
 * without rewiring the topology. Today `draft` and `plan` reach the same
 * server endpoint (the system prompt is identical for those two phases —
 * see dec-1 of doc-12).
 */
export type SpecPhase = 'draft' | 'plan' | 'build' | 'verify' | 'done';

/**
 * Tool-name regex matching mutation tools. The `doneAgent` path filters any
 * matching server tool calls so the "done" phase is effectively read-only —
 * the agent can still query the doc, but cannot mutate it.
 */
export const MUTATION_TOOL_PATTERN =
  /^(create_|update_|resolve_|add_|delete_|publish_|reopen_|approve_|reject_|set_|propose_)/;

/** UI tool names that should be rendered client-side, not executed server-side */
export const UI_TOOL_NAMES = new Set([
  'render_action_buttons',
  'render_choices',
  'render_confirmation',
  'render_progress',
  'render_callout',
  'render_steps',
]);

/**
 * UI tools that wait for an explicit user response before the agent continues.
 * The graph exits these so React can handle the interaction.
 */
export const INTERACTIVE_UI_TOOL_NAMES = new Set([
  'render_action_buttons',
  'render_choices',
  'render_confirmation',
]);

/**
 * UI tools that are purely display / visual sugar and do not need a user response.
 * When the agent emits one of these alongside server tools (or alone), the graph
 * synthesises an empty tool_result so the conversation continues without a stall.
 */
export const DISPLAY_UI_TOOL_NAMES = new Set([
  'render_progress',
  'render_callout',
  'render_steps',
]);
