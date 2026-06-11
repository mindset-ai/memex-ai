// spec-190 t-3 / dec-1: the guide's client-side LangGraph. It mirrors the
// established pattern (agent/graph.ts) — browser-resident graph, server SSE proxy
// for LLM calls (guideLlmClient.ts), client-executed UI tools — but is a single
// conversational loop, NOT per-screen nodes:
//
//     __start__ → guideAgent → shouldContinue → (tools → guideAgent | __end__)
//
// Screens are STATE, not nodes (ac-11). The existing graph has per-phase nodes
// because behaviour differs per phase; the guide's behaviour and toolset are
// identical on every screen — only the CONTEXT differs. So screenKey,
// screenRegistry and guideContext live in graph state and are updated before the
// next turn on any screen change (user- or agent-driven). Adding a screen needs
// registry + content entries only (t-4/t-6) — never a graph change.

import { Annotation, StateGraph, MemorySaver } from '@langchain/langgraph';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  callGuideLlmProxy,
  type GuideScreenElement,
  type GuideScreenSummary,
} from './guideLlmClient';
import type { MessageParam, ContentBlock, ToolUseBlock } from './agent-types';

/** Tools the guide executes CLIENT-side (React performs them): highlight a
 *  registry element, navigate to a registry screen (dec-4, t-5), and advance the
 *  demo board during the synced walkthrough (spec-206 t-4, dec-1). search_guide is
 *  a SERVER tool (dec-6, t-6) executed via the injected executor. */
export const GUIDE_CLIENT_TOOLS = new Set([
  'highlight',
  'navigate',
  'advance_demo',
  // spec-211 t-3: handing control to the client demo-walkthrough sequencer.
  'start_walkthrough',
]);

export const GuideState = Annotation.Root({
  /** Anthropic-format conversation. */
  messages: Annotation<MessageParam[]>({
    reducer: (prev, update) => [...prev, ...update],
    default: () => [],
  }),
  /** Current screen's stable key (route-derived). Replaced on screen change. */
  screenKey: Annotation<string | null>({
    reducer: (_, update) => update,
    default: () => null,
  }),
  /** Current screen's highlightable elements (dec-3 registry). Replaced on change. */
  screenRegistry: Annotation<GuideScreenElement[]>({
    reducer: (_, update) => update,
    default: () => [],
  }),
  /** The host's complete navigable-screen list (site map). Static per session;
   *  sent every turn so the model knows what pages exist. */
  screens: Annotation<GuideScreenSummary[]>({
    reducer: (_, update) => update,
    default: () => [],
  }),
  /** Current screen's pre-fetched guide-content chunks (dec-6). Replaced on change. */
  guideContext: Annotation<string[]>({
    reducer: (_, update) => update,
    default: () => [],
  }),
});

export type GuideStateType = typeof GuideState.State;

export interface GuideCallbacks {
  onTextDelta?: (text: string) => void;
  /** A client-executed UI tool the React layer must perform (highlight/navigate).
   *  The return value (e.g. a NavigateOutcome) is serialized into the tool_result
   *  so the model knows whether the action actually happened — a bare 'executed'
   *  let it believe a navigation failed when the (stale) screen context still
   *  named the old screen. */
  onUiTool?: (toolName: string, toolId: string, input: Record<string, unknown>) => unknown;
  onToolResult?: (toolId: string, result: string) => void;
  onAssistantTurnComplete?: (content: ContentBlock[]) => void;
}

export interface GuideConfig {
  callbacks?: GuideCallbacks;
  signal?: AbortSignal;
}

export interface GuideGraphDeps {
  /** Live screen-context reader. After a client tool runs (navigate changes the
   *  route mid-turn), the post-tool LLM call must carry the NEW screen's key and
   *  elements — re-read here rather than trusting the turn-start snapshot. */
  getScreenContext?: () => { screenKey: string | null; screenRegistry: GuideScreenElement[] };
  /** Server-tool executor (search_guide). Injected so the graph is testable and
   *  so t-5/t-6 can wire the real implementation without touching the graph. */
  executeServerTool?: (
    name: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<string>;
}

function getToolUseBlocks(msg: MessageParam): ToolUseBlock[] {
  if (!Array.isArray(msg.content)) return [];
  return msg.content.filter(
    (b): b is ToolUseBlock => (b as ContentBlock).type === 'tool_use',
  );
}

async function guideAgentNode(
  state: GuideStateType,
  config: RunnableConfig,
): Promise<Partial<GuideStateType>> {
  const { callbacks, signal } = (config.configurable ?? {}) as GuideConfig;

  let completedContent: ContentBlock[] = [];
  for await (const event of callGuideLlmProxy(
    {
      messages: state.messages,
      // Screen context is read from STATE every turn — a screen change updates
      // these before the next turn (ac-11), so the guide is always answering
      // about the screen the user is actually on.
      screenKey: state.screenKey,
      screenRegistry: state.screenRegistry,
      screens: state.screens,
      guideContext: state.guideContext,
    },
    signal,
  )) {
    switch (event.type) {
      case 'text_delta':
        callbacks?.onTextDelta?.(event.text);
        break;
      case 'message_complete':
        completedContent = event.content;
        break;
      case 'error':
        throw new Error(event.message);
    }
  }

  callbacks?.onAssistantTurnComplete?.(completedContent);
  return { messages: [{ role: 'assistant' as const, content: completedContent }] };
}

function shouldContinue(state: GuideStateType): 'tools' | '__end__' {
  const last = state.messages[state.messages.length - 1];
  if (!last || last.role !== 'assistant') return '__end__';
  return getToolUseBlocks(last).length > 0 ? 'tools' : '__end__';
}

async function guideToolsNode(
  state: GuideStateType,
  config: RunnableConfig,
  executeServerTool: NonNullable<GuideGraphDeps['executeServerTool']>,
  getScreenContext?: GuideGraphDeps['getScreenContext'],
): Promise<Partial<GuideStateType>> {
  const { callbacks, signal } = (config.configurable ?? {}) as GuideConfig;
  const last = state.messages[state.messages.length - 1];
  const toolBlocks = getToolUseBlocks(last);
  const results: ContentBlock[] = [];
  let clientToolRan = false;

  for (const block of toolBlocks) {
    if (GUIDE_CLIENT_TOOLS.has(block.name)) {
      // highlight / navigate — React performs it (dec-4, t-5). The dispatch
      // outcome (e.g. navigate's { ok, path }) goes into the tool_result so the
      // model knows the action's real result; the loop continues so the guide
      // can keep talking.
      clientToolRan = true;
      let outcome: unknown;
      try {
        outcome = callbacks?.onUiTool?.(block.name, block.id, block.input);
      } catch {
        outcome = { ok: false, reason: 'tool dispatch threw' };
      }
      const content =
        typeof outcome === 'string'
          ? outcome
          : outcome !== undefined
            ? JSON.stringify(outcome)
            : 'executed';
      results.push({ type: 'tool_result', tool_use_id: block.id, content });
      continue;
    }
    // search_guide — server tool (dec-6, t-6).
    try {
      const result = await executeServerTool(block.name, block.input, signal);
      callbacks?.onToolResult?.(block.id, result);
      results.push({ type: 'tool_result', tool_use_id: block.id, content: result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      callbacks?.onToolResult?.(block.id, `Error: ${message}`);
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: `Error: ${message}`,
        is_error: true,
      });
    }
  }

  // A client tool may have changed the screen (navigate soft-navs an SPA host
  // mid-turn). Refresh the screen state so the post-tool LLM call carries the
  // NEW screen's key + elements instead of the turn-start snapshot — otherwise
  // the injected context contradicts the tool_result and the model concludes
  // the navigation never happened.
  if (clientToolRan && getScreenContext) {
    const fresh = getScreenContext();
    return {
      messages: [{ role: 'user' as const, content: results }],
      screenKey: fresh.screenKey,
      screenRegistry: fresh.screenRegistry,
    };
  }
  return { messages: [{ role: 'user' as const, content: results }] };
}

export function createGuideGraph(deps: GuideGraphDeps = {}) {
  const executeServerTool =
    deps.executeServerTool ??
    (async (name: string) => {
      throw new Error(`Guide server tool "${name}" is not wired yet (t-5/t-6)`);
    });

  const checkpointer = new MemorySaver();
  return new StateGraph(GuideState)
    .addNode('guideAgent', guideAgentNode)
    .addNode('tools', (s: GuideStateType, c: RunnableConfig) =>
      guideToolsNode(s, c, executeServerTool, deps.getScreenContext),
    )
    .addEdge('__start__', 'guideAgent')
    .addConditionalEdges('guideAgent', shouldContinue, {
      tools: 'tools',
      __end__: '__end__',
    })
    .addEdge('tools', 'guideAgent')
    .compile({ checkpointer });
}
