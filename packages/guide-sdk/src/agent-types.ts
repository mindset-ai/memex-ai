// spec-222 — the engine's OWN copy of the Anthropic-compatible message types.
// Carved out of the app's `packages/ui/src/agent/types.ts` so the guide engine
// never imports the app's agent module: the SDK owns the shapes it needs for the
// guide-LLM proxy leg (guideLlmClient.ts) and the graph (guideGraph.ts). These
// mirror the Anthropic API format but don't require the SDK.

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
