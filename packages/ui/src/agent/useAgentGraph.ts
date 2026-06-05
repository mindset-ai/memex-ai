import { useRef, useCallback } from 'react';
import { createAgentGraph } from './graph';
import type { AgentCallbacks } from './graph';
import type { MessageParam, ContentBlock, ToolUseBlock, SpecPhase } from './types';
import { UI_TOOL_NAMES } from './types';
import type { ContextChip } from '../api/types';

export interface InvokeParams {
  userMessage: string;
  docId?: string | null;
  /**
   * Current Spec phase, if known. Used by the graph router to pick the
   * right per-phase agent node. Leave undefined for non-Spec docs or
   * when the phase is unknown — the graph falls through to a safe default.
   */
  specPhase?: SpecPhase | null;
  contextChips?: ContextChip[];
  /** Existing messages to prepend (for conversation restore) */
  existingMessages?: MessageParam[];
  /**
   * spec-143 t-4 (dec-6): the agent mode. `'drift'` routes to the memex-scoped
   * drift agent (no bound doc); default `'spec'` is the doc/creation agent.
   */
  agentMode?: 'spec' | 'drift';
  callbacks: AgentCallbacks;
  signal?: AbortSignal;
}

export interface ResumeParams {
  docId?: string | null;
  /** Current Spec phase, if known — see `InvokeParams`. */
  specPhase?: SpecPhase | null;
  /** spec-143 t-4 (dec-6): the agent mode — see `InvokeParams`. */
  agentMode?: 'spec' | 'drift';
  /** Full conversation messages including the UI tool result */
  messages: MessageParam[];
  callbacks: AgentCallbacks;
  signal?: AbortSignal;
}

export interface InvokeResult {
  messages: MessageParam[];
  docId: string | null;
}

/**
 * Returns the final assistant message's UI tool blocks, if any.
 * Used by ChatContext to detect when the graph exited due to a UI tool.
 */
export function getPendingUiTools(messages: MessageParam[]): ToolUseBlock[] {
  if (messages.length === 0) return [];
  const lastMsg = messages[messages.length - 1];
  if (lastMsg.role !== 'assistant' || !Array.isArray(lastMsg.content)) return [];
  return (lastMsg.content as ContentBlock[]).filter(
    (b): b is ToolUseBlock => b.type === 'tool_use' && UI_TOOL_NAMES.has(b.name)
  );
}

/**
 * React hook wrapping the LangGraph agent graph.
 *
 * The graph has two top-level phases:
 * - Creation phase (no docId): focused prompt, only create_doc + UI tools
 * - Document phase (has docId): full document context + tools, fanned out
 *   into four per-phase nodes (`planAgent` / `buildAgent` / `verifyAgent` /
 *   `doneAgent`) so future per-phase divergence is a one-line change.
 *   `draft` is a Spec attribute / Kanban column, not a graph node — it
 *   routes to `planAgent`. The `done` phase is read-only — mutation tools
 *   are filtered out at the tools node.
 *
 * The router at graph entry automatically selects the phase based on
 * `docId` and `specPhase`. Callers that don't know the current phase
 * can omit it; the router falls through to a safe `planAgent` default.
 */
export function useAgentGraph() {
  const graphRef = useRef(createAgentGraph());
  const threadCounterRef = useRef(0);

  const invoke = useCallback(
    async ({
      userMessage,
      docId = null,
      specPhase = null,
      contextChips,
      existingMessages = [],
      agentMode = 'spec',
      callbacks,
      signal,
    }: InvokeParams): Promise<InvokeResult> => {
      const threadId = `thread-${++threadCounterRef.current}`;

      // If the user has a section/decision/task focus set in the chat UI,
      // prefix the message with `[Focus: <label>]` — the system prompt
      // documents this format and tells the agent to scope its response
      // accordingly. The prefix is persisted in the conversation history
      // so the agent retains "what was focused at that turn"; the UI
      // strips it on display (see ChatContext.loadConversation handler).
      const focus = contextChips?.[0];
      const decoratedMessage = focus
        ? `[Focus: ${focus.label}] ${userMessage}`
        : userMessage;

      const inputMessages: MessageParam[] = [
        ...existingMessages,
        { role: 'user' as const, content: decoratedMessage },
      ];

      const result = await graphRef.current.invoke(
        { messages: inputMessages, docId, specPhase, agentMode },
        {
          // LangGraph's default recursionLimit is 25. Codebase-intelligence
          // queries naturally chain multiple tool calls (e.g. an auth-coverage
          // audit that walks every endpoint's call graph), and 25 is too tight.
          // 75 gives comfortable headroom without letting a runaway loop burn
          // forever.
          recursionLimit: 75,
          configurable: {
            thread_id: threadId,
            callbacks,
            signal,
          },
          signal,
        }
      );

      return { messages: result.messages, docId: result.docId };
    },
    []
  );

  const resume = useCallback(
    async ({
      docId = null,
      specPhase = null,
      agentMode = 'spec',
      messages,
      callbacks,
      signal,
    }: ResumeParams): Promise<InvokeResult> => {
      const threadId = `thread-${++threadCounterRef.current}`;

      const result = await graphRef.current.invoke(
        { messages, docId, specPhase, agentMode },
        {
          recursionLimit: 75,
          configurable: {
            thread_id: threadId,
            callbacks,
            signal,
          },
          signal,
        }
      );

      return { messages: result.messages, docId: result.docId };
    },
    []
  );

  return { invoke, resume };
}
