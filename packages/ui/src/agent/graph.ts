import { Annotation, StateGraph, MemorySaver } from '@langchain/langgraph';
import type { RunnableConfig } from '@langchain/core/runnables';
import { callLlmProxy, callLlmCreateProxy } from './llm-client';
import { executeToolRemote } from './tool-client';
import type { MessageParam, ContentBlock, ToolUseBlock, SpecPhase } from './types';
import {
  UI_TOOL_NAMES,
  INTERACTIVE_UI_TOOL_NAMES,
  DISPLAY_UI_TOOL_NAMES,
  MUTATION_TOOL_PATTERN,
} from './types';

// ──────────────────────────────────────────────
// State
// ──────────────────────────────────────────────

export const AgentState = Annotation.Root({
  /** Anthropic-format messages (the full conversation) */
  messages: Annotation<MessageParam[]>({
    reducer: (prev, update) => [...prev, ...update],
    default: () => [],
  }),
  /** Document ID — null during creation phase, set after create_doc */
  docId: Annotation<string | null>({
    reducer: (_, update) => update,
    default: () => null,
  }),
  /**
   * Spec lifecycle phase. `null` falls through to the safe `planAgent`
   * fallback in `routeByPhase`. Set by callers (`useAgentGraph`) when the
   * caller knows the doc's current phase; otherwise unset.
   */
  specPhase: Annotation<SpecPhase | null>({
    reducer: (_, update) => update,
    default: () => null,
  }),
  /**
   * spec-143 t-4 (dec-6): the agent MODE. `'spec'` (default) is the doc/creation
   * agent; `'drift'` is the Drift Inbox agent — memex-scoped, no bound doc. In
   * drift mode the entry router goes straight to an agent node (not createDoc)
   * even with no docId, and the mode is forwarded to the server (chat + tools).
   */
  agentMode: Annotation<'spec' | 'drift'>({
    reducer: (_, update) => update,
    default: () => 'spec',
  }),
});

export type AgentStateType = typeof AgentState.State;

/** Callbacks for streaming UI updates from within graph nodes */
export interface AgentCallbacks {
  onTextDelta?: (text: string) => void;
  onToolStart?: (toolName: string, toolId: string) => void;
  onToolResult?: (toolId: string, result: string) => void;
  onUiTool?: (toolName: string, toolId: string, input: Record<string, unknown>) => void;
  /**
   * Fires once an assistant turn completes, with the full ordered content blocks
   * (text + tool_use). Consumers should use this instead of onUiTool when they
   * need to render UI tools at the correct position relative to streamed text,
   * rather than all at the end.
   */
  onAssistantTurnComplete?: (content: ContentBlock[]) => void;
  onDocCreated?: (info: { docId: string; handle: string; title: string }) => void;
}

/** Config passed via RunnableConfig.configurable */
export interface AgentConfig {
  callbacks?: AgentCallbacks;
  signal?: AbortSignal;
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function getToolUseBlocks(msg: MessageParam): ToolUseBlock[] {
  if (!Array.isArray(msg.content)) return [];
  return msg.content.filter(
    (b): b is ToolUseBlock => (b as ContentBlock).type === 'tool_use'
  );
}

function getServerToolBlocks(blocks: ToolUseBlock[]): ToolUseBlock[] {
  return blocks.filter((b) => !UI_TOOL_NAMES.has(b.name));
}

function getUiToolBlocks(blocks: ToolUseBlock[]): ToolUseBlock[] {
  return blocks.filter((b) => UI_TOOL_NAMES.has(b.name));
}

function getInteractiveUiToolBlocks(blocks: ToolUseBlock[]): ToolUseBlock[] {
  return blocks.filter((b) => INTERACTIVE_UI_TOOL_NAMES.has(b.name));
}

function getDisplayUiToolBlocks(blocks: ToolUseBlock[]): ToolUseBlock[] {
  return blocks.filter((b) => DISPLAY_UI_TOOL_NAMES.has(b.name));
}

// The success prefix the server prepends to a create_doc result has changed
// twice — the doc-type noun went `Document` → `Brief` → `Spec` (b-36, then
// b-105) and a `ref:` token was inserted ahead of the canonical path. Each
// rename silently broke this parser until caught. Match the noun loosely and
// the `ref:` token optionally so a future rename can't re-break create
// detection. Anchoring on the literal `Document created:` is what stranded the
// modal when the server moved to `Spec created: ref: …`.
//
// spec-158 t-5: create_doc's promote paths (promoteFromIssueRef /
// promoteFromTaskRef) don't say "<noun> created:" — they say
// `Promoted issue issue-N to Spec ref: <ref> "<title>".` (and `Promoted issue
// … to child Spec ref: …` in verbose). That's still a create, and the Issues
// page's Convert-to-Spec action relies on onDocCreated firing to refetch — so
// accept the promote lead-in too. Without this the doc_created card + the
// caller's onCreated never fire when converting an Issue.
const CREATED_PREFIX = String.raw`(?:(?:Document|Brief|Spec) created:|Promoted (?:issue|Issue|task|Task) \S+ to (?:child )?Spec):?\s*(?:ref:\s*)?`;

/**
 * Extract document id, handle, and title from a create_doc tool result.
 *
 * The server has emitted three shapes over time — we accept all of them so this
 * keeps working as the formatter evolves under the canonical-ref work:
 *
 *   - Legacy uuid: `Document created: <handle> (uuid: <uuid>) "<title>". ...`
 *   - Canonical:   `Spec created: ref: <ns>/<mx>/<doc-type>/<handle> "<title>". ...`
 *   - Bare handle: `Spec created: ref: <handle> "<title>". ...`  (slug-less fallback)
 *
 * In the canonical / bare-handle shapes we don't surface a UUID to consumers —
 * the navigation widget downstream (`NewSpecModal`) doesn't render \`docId\`
 * anywhere user-visible, so we feed it the canonical ref (or the handle) as a
 * stable opaque id. Anything that actually needs the UUID can resolve it via
 * the API.
 *
 * Exported for direct branch testing (same precedent as `routeByPhase`) —
 * spec-155 ac-5 pins every shape, including the null path, in graph.test.ts.
 */
export function extractDocInfo(
  toolResult: string
): { docId: string; handle: string; title: string } | null {
  // Legacy uuid format: `<handle> (uuid: <uuid>) "<title>"`.
  const legacy = toolResult.match(
    new RegExp(CREATED_PREFIX + String.raw`(\S+)\s+\(uuid:\s*([0-9a-f-]+)\)\s+"([^"]*)"`)
  );
  if (legacy) {
    return { handle: legacy[1], docId: legacy[2], title: legacy[3] };
  }
  // Canonical-ref format: `<ns>/<mx>/<doc-type>/<handle> "<title>"`. Pull the
  // trailing handle off the canonical path so existing consumers keep working;
  // docId carries the full ref (no UUID is surfaced in this shape).
  const refOnly = toolResult.match(
    new RegExp(
      CREATED_PREFIX +
        String.raw`([a-z][a-z0-9-]*\/[a-z][a-z0-9-]*\/(?:specs|briefs|docs|standards|execution-plans)\/((?:spec|b|doc|std)-\d+))\s+"([^"]*)"`
    )
  );
  if (refOnly) {
    return { handle: refOnly[2], docId: refOnly[1], title: refOnly[3] };
  }
  // Bare-handle fallback: when the server can't resolve slugs it emits the bare
  // handle in place of a full path (`ref: spec-N "<title>"`). Surface the handle
  // as both id and handle so the modal still detects the create.
  const bareHandle = toolResult.match(
    new RegExp(CREATED_PREFIX + String.raw`((?:spec|b|doc|std)-\d+)\s+"([^"]*)"`)
  );
  if (bareHandle) {
    return { handle: bareHandle[1], docId: bareHandle[1], title: bareHandle[2] };
  }
  return null;
}

// ──────────────────────────────────────────────
// Routers — entry + tools-loopback
// ──────────────────────────────────────────────

/**
 * Names of the per-phase agent nodes. Kept as a const tuple so adding a phase
 * here forces a TS error in every router/edge that needs updating.
 */
export type PhaseAgentName =
  | 'planAgent'
  | 'buildAgent'
  | 'verifyAgent'
  | 'doneAgent';

/**
 * Entry router: picks creation vs the appropriate per-phase agent.
 * `draft` is a Spec attribute / Kanban column, not a graph node — both
 * `draft` and `specify` route to `planAgent`. When the caller hasn't supplied
 * a phase we fall through to `planAgent` as the safest default for an
 * existing doc whose phase is unknown.
 */
export function routeByPhase(
  state: AgentStateType
): 'createDoc' | PhaseAgentName {
  // spec-143 t-4 (dec-6): drift mode has no bound doc but is NOT creation —
  // route straight to the agent node. It reuses planAgent (the generic
  // agentNode); the drift posture comes from the server-side prompt + tool
  // subset selected by `mode: 'drift'`, not from a distinct client node.
  if (state.agentMode === 'drift') return 'planAgent';
  if (!state.docId) return 'createDoc';
  switch (state.specPhase) {
    case 'draft':
    case 'specify':
      return 'planAgent';
    case 'build':
      return 'buildAgent';
    case 'verify':
      return 'verifyAgent';
    case 'done':
      return 'doneAgent';
    default:
      return 'planAgent';
  }
}

/**
 * After `tools` runs we need to return to the originating per-phase agent.
 * We re-derive it from `state.specPhase` rather than tracking the active
 * node explicitly — if the phase changes mid-loop the next turn will pick
 * the right agent on its own.
 */
function routeBackToPhase(state: AgentStateType): PhaseAgentName {
  switch (state.specPhase) {
    case 'draft':
    case 'specify':
      return 'planAgent';
    case 'build':
      return 'buildAgent';
    case 'verify':
      return 'verifyAgent';
    case 'done':
      return 'doneAgent';
    default:
      return 'planAgent';
  }
}

// ──────────────────────────────────────────────
// Creation phase nodes
// ──────────────────────────────────────────────

async function createDocNode(
  state: AgentStateType,
  config: RunnableConfig
): Promise<Partial<AgentStateType>> {
  const { callbacks, signal } = (config.configurable ?? {}) as AgentConfig;

  console.log('[LANGGRAPH] createDoc node invoked — messages:', state.messages.length);

  let completedContent: ContentBlock[] = [];

  for await (const event of callLlmCreateProxy(
    { messages: state.messages },
    signal
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

  // Announce the completed turn with full ordered content so consumers can render
  // text and UI tool blocks in the correct positions. onUiTool also fires for
  // backward-compatible consumers that don't care about ordering.
  callbacks?.onAssistantTurnComplete?.(completedContent);
  const toolBlocks = completedContent.filter(
    (b): b is ToolUseBlock => b.type === 'tool_use'
  );
  for (const block of getUiToolBlocks(toolBlocks)) {
    callbacks?.onUiTool?.(block.name, block.id, block.input);
  }

  return {
    messages: [{ role: 'assistant' as const, content: completedContent }],
  };
}

function shouldContinueCreate(state: AgentStateType): 'createDocTools' | '__end__' {
  const lastMsg = state.messages[state.messages.length - 1];
  if (lastMsg.role !== 'assistant') return '__end__';

  const toolBlocks = getToolUseBlocks(lastMsg);
  if (toolBlocks.length === 0) return '__end__';

  // Exit only if an interactive UI tool is present — those await a user response.
  // Display-only UI tools (callout, steps, progress) and server tools are handled
  // in the tools node with synthesised / real results so the loop keeps going.
  if (getInteractiveUiToolBlocks(toolBlocks).length > 0) return '__end__';

  return 'createDocTools';
}

async function createDocToolsNode(
  state: AgentStateType,
  config: RunnableConfig
): Promise<Partial<AgentStateType>> {
  const { callbacks, signal } = (config.configurable ?? {}) as AgentConfig;
  const lastMsg = state.messages[state.messages.length - 1];
  const toolBlocks = getToolUseBlocks(lastMsg);
  const serverBlocks = getServerToolBlocks(toolBlocks);
  const displayUiBlocks = getDisplayUiToolBlocks(toolBlocks);

  const results: ContentBlock[] = [];

  for (const block of serverBlocks) {
    callbacks?.onToolStart?.(block.name, block.id);
    try {
      const result = await executeToolRemote(block.name, block.input, signal);
      callbacks?.onToolResult?.(block.id, result);
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: result,
      });

      // Announce created doc (with handle + title) so the modal can surface a link.
      if (block.name === 'create_doc') {
        const info = extractDocInfo(result);
        if (info) callbacks?.onDocCreated?.(info);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      callbacks?.onToolResult?.(block.id, `Error: ${errMsg}`);
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: `Error: ${errMsg}`,
        is_error: true,
      });
    }
  }

  // Display-only UI tools (render_callout / render_steps / render_progress) get a
  // synthesised tool_result so Anthropic's tool-use round-trip is valid. The block
  // was already forwarded to the UI via onUiTool when the assistant turn completed.
  for (const block of displayUiBlocks) {
    results.push({
      type: 'tool_result',
      tool_use_id: block.id,
      content: 'displayed',
    });
  }

  return {
    messages: [{ role: 'user' as const, content: results }],
    // Don't set docId — stay in creation phase until user navigates to the doc
  };
}

// ──────────────────────────────────────────────
// Per-phase agent nodes
// ──────────────────────────────────────────────

async function agentNode(
  state: AgentStateType,
  config: RunnableConfig,
  phaseLabel: string
): Promise<Partial<AgentStateType>> {
  const { callbacks, signal } = (config.configurable ?? {}) as AgentConfig;

  console.log(
    `[LANGGRAPH] ${phaseLabel} node invoked — messages:`,
    state.messages.length,
    'docId:',
    state.docId,
    'phase:',
    state.specPhase
  );

  let completedContent: ContentBlock[] = [];

  for await (const event of callLlmProxy(
    {
      docId: state.docId ?? undefined,
      messages: state.messages,
      // spec-143 t-4 (dec-6): forward the mode so the server runs the drift
      // agent (open-drift context + drift prompt + drift tool subset).
      mode: state.agentMode === 'drift' ? 'drift' : undefined,
    },
    signal
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

  // Announce the completed turn with full ordered content so consumers can render
  // text and UI tool blocks in the correct positions. onUiTool also fires for
  // backward-compatible consumers that don't care about ordering.
  callbacks?.onAssistantTurnComplete?.(completedContent);
  const toolBlocks = completedContent.filter(
    (b): b is ToolUseBlock => b.type === 'tool_use'
  );
  for (const block of getUiToolBlocks(toolBlocks)) {
    callbacks?.onUiTool?.(block.name, block.id, block.input);
  }

  return {
    messages: [{ role: 'assistant' as const, content: completedContent }],
  };
}

const planAgent = (state: AgentStateType, config: RunnableConfig) =>
  agentNode(state, config, 'planAgent');
const buildAgent = (state: AgentStateType, config: RunnableConfig) =>
  agentNode(state, config, 'buildAgent');
const verifyAgent = (state: AgentStateType, config: RunnableConfig) =>
  agentNode(state, config, 'verifyAgent');
const doneAgent = (state: AgentStateType, config: RunnableConfig) =>
  agentNode(state, config, 'doneAgent');

/**
 * Shared continuation gate for every per-phase agent. Routes to the
 * appropriate tools node — `doneTools` for the done phase (filters
 * mutations), `tools` for everyone else.
 */
function shouldContinue(
  state: AgentStateType
): 'tools' | 'doneTools' | '__end__' {
  const lastMsg = state.messages[state.messages.length - 1];
  if (lastMsg.role !== 'assistant') return '__end__';

  const toolBlocks = getToolUseBlocks(lastMsg);
  if (toolBlocks.length === 0) return '__end__';

  // Interactive UI tools pause the loop; display-only UI tools and server tools
  // keep it going so visual sugar doesn't stall the conversation.
  if (getInteractiveUiToolBlocks(toolBlocks).length > 0) return '__end__';

  return state.specPhase === 'done' ? 'doneTools' : 'tools';
}

// ──────────────────────────────────────────────
// Tools nodes
//
// We use a separate `doneToolsNode` rather than inline filtering because it
// keeps the read-only enforcement local to the done path and doesn't
// complicate the (much hotter) default `toolsNode`.
// ──────────────────────────────────────────────

async function toolsNode(
  state: AgentStateType,
  config: RunnableConfig
): Promise<Partial<AgentStateType>> {
  const { callbacks, signal } = (config.configurable ?? {}) as AgentConfig;
  const lastMsg = state.messages[state.messages.length - 1];
  const toolBlocks = getToolUseBlocks(lastMsg);
  const serverBlocks = getServerToolBlocks(toolBlocks);
  const displayUiBlocks = getDisplayUiToolBlocks(toolBlocks);

  // The doc this chat is bound to — threaded into the server tool ctx so
  // tools like search_memex can default-exclude self-hits (b-34 T-12).
  const currentDocId = state.docId ?? undefined;
  // spec-143 t-4 (dec-6): in drift mode there's no bound doc — forward the mode
  // so the server runs the drift tool surface with docId null.
  const toolMode = state.agentMode === 'drift' ? 'drift' : undefined;

  const results: ContentBlock[] = [];

  for (const block of serverBlocks) {
    callbacks?.onToolStart?.(block.name, block.id);
    try {
      const result = await executeToolRemote(block.name, block.input, signal, currentDocId, toolMode);
      callbacks?.onToolResult?.(block.id, result);
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: result,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      callbacks?.onToolResult?.(block.id, `Error: ${errMsg}`);
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: `Error: ${errMsg}`,
        is_error: true,
      });
    }
  }

  for (const block of displayUiBlocks) {
    results.push({
      type: 'tool_result',
      tool_use_id: block.id,
      content: 'displayed',
    });
  }

  return {
    messages: [{ role: 'user' as const, content: results }],
  };
}

/**
 * Read-only tools node for the `done` phase. Mutation tools (matched by
 * `MUTATION_TOOL_PATTERN`) get a synthesised error tool_result so the agent
 * sees the rejection and can adjust; non-mutation tools execute normally.
 *
 * A closed Spec is reference material — let the agent answer questions,
 * but don't let it edit the doc out from under the user.
 */
async function doneToolsNode(
  state: AgentStateType,
  config: RunnableConfig
): Promise<Partial<AgentStateType>> {
  const { callbacks, signal } = (config.configurable ?? {}) as AgentConfig;
  const lastMsg = state.messages[state.messages.length - 1];
  const toolBlocks = getToolUseBlocks(lastMsg);
  const serverBlocks = getServerToolBlocks(toolBlocks);
  const displayUiBlocks = getDisplayUiToolBlocks(toolBlocks);

  const currentDocId = state.docId ?? undefined;

  const results: ContentBlock[] = [];

  for (const block of serverBlocks) {
    if (MUTATION_TOOL_PATTERN.test(block.name)) {
      const errMsg = `Error: ${block.name} is not allowed while the Spec is in 'done' phase. The Spec is closed and read-only; reopen it (move it back to verify) before mutating.`;
      callbacks?.onToolResult?.(block.id, errMsg);
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: errMsg,
        is_error: true,
      });
      continue;
    }
    callbacks?.onToolStart?.(block.name, block.id);
    try {
      const result = await executeToolRemote(block.name, block.input, signal, currentDocId);
      callbacks?.onToolResult?.(block.id, result);
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: result,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      callbacks?.onToolResult?.(block.id, `Error: ${errMsg}`);
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: `Error: ${errMsg}`,
        is_error: true,
      });
    }
  }

  for (const block of displayUiBlocks) {
    results.push({
      type: 'tool_result',
      tool_use_id: block.id,
      content: 'displayed',
    });
  }

  return {
    messages: [{ role: 'user' as const, content: results }],
  };
}

// ──────────────────────────────────────────────
// Graph compilation
// ──────────────────────────────────────────────

export function createAgentGraph() {
  const checkpointer = new MemorySaver();

  const graph = new StateGraph(AgentState)
    // Creation phase
    .addNode('createDoc', createDocNode)
    .addNode('createDocTools', createDocToolsNode)
    // Per-phase document agents. `draft` is a Spec attribute / Kanban
    // column — there is no draftAgent; draft routes to planAgent.
    .addNode('planAgent', planAgent)
    .addNode('buildAgent', buildAgent)
    .addNode('verifyAgent', verifyAgent)
    .addNode('doneAgent', doneAgent)
    // Shared tools nodes
    .addNode('tools', toolsNode)
    .addNode('doneTools', doneToolsNode)
    // Entry: router decides creation vs phase
    .addConditionalEdges('__start__', routeByPhase, {
      createDoc: 'createDoc',
      planAgent: 'planAgent',
      buildAgent: 'buildAgent',
      verifyAgent: 'verifyAgent',
      doneAgent: 'doneAgent',
    })
    // Creation phase edges
    .addConditionalEdges('createDoc', shouldContinueCreate, {
      createDocTools: 'createDocTools',
      __end__: '__end__',
    })
    .addEdge('createDocTools', 'createDoc')
    // Per-phase agent → tools (or doneTools) → back to originating phase
    .addConditionalEdges('planAgent', shouldContinue, {
      tools: 'tools',
      doneTools: 'doneTools',
      __end__: '__end__',
    })
    .addConditionalEdges('buildAgent', shouldContinue, {
      tools: 'tools',
      doneTools: 'doneTools',
      __end__: '__end__',
    })
    .addConditionalEdges('verifyAgent', shouldContinue, {
      tools: 'tools',
      doneTools: 'doneTools',
      __end__: '__end__',
    })
    .addConditionalEdges('doneAgent', shouldContinue, {
      tools: 'tools',
      doneTools: 'doneTools',
      __end__: '__end__',
    })
    // tools loops back to whichever phase agent owns the conversation
    .addConditionalEdges('tools', routeBackToPhase, {
      planAgent: 'planAgent',
      buildAgent: 'buildAgent',
      verifyAgent: 'verifyAgent',
      doneAgent: 'doneAgent',
    })
    .addConditionalEdges('doneTools', routeBackToPhase, {
      planAgent: 'planAgent',
      buildAgent: 'buildAgent',
      verifyAgent: 'verifyAgent',
      doneAgent: 'doneAgent',
    })
    .compile({ checkpointer });

  return graph;
}
