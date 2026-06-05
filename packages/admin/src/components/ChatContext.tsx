import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
  type ReactNode,
} from 'react';
import { useAuth } from './AuthContext';
import { useAgentGraph } from '../agent/useAgentGraph';
import { setLlmAuthToken } from '../agent/llm-client';
import { setToolAuthToken } from '../agent/tool-client';
import {
  setConversationAuthToken,
  saveConversation,
  clearConversationRemote,
} from '../agent/conversation-client';
import type {
  ChatMessage,
  ContextChip,
  DocWithGraph,
} from '../api/types';
import type { MessageParam, ContentBlock, ToolUseBlock } from '../agent/types';
import { UI_TOOL_NAMES, DISPLAY_UI_TOOL_NAMES } from '../agent/types';
import { executeToolRemote } from '../agent/tool-client';
import type { AgentCallbacks } from '../agent/graph';

interface ChatState {
  messages: ChatMessage[];
  isStreaming: boolean;
  error: string | null;
  contextChips: ContextChip[];
  doc: DocWithGraph | null;
  docId: string | null;
  /**
   * spec-123 t-2: open (unresolved) comment count for the current Spec. Synced
   * by DocDocument alongside `setDoc` (the count is computed there from the
   * fetched comment sets, not carried on the doc). DocDocument's reviewer block
   * feeds it to computeSpecReadiness so its "Resolve Comments" helper gates
   * correctly (ac-9).
   */
  openCommentCount: number;
  respondedToolIds: Set<string>;
  /**
   * spec-143 t-4 (dec-6): the agent mode. `'drift'` makes the agent the
   * memex-scoped drift agent (no bound doc) — the Drift Inbox sets it on mount
   * via `enterDriftMode` and clears it on unmount via `exitDriftMode`. Default
   * `'spec'` is the doc/creation agent, unchanged.
   */
  isDriftMode: boolean;
  /** Enter drift mode — the agent runs against this Memex's open Standards drift. */
  enterDriftMode: () => void;
  /** Leave drift mode — back to the default doc/creation agent. */
  exitDriftMode: () => void;
  /**
   * spec-143 t-4 (dec-6): fire the drift agent's opening turn ONCE on Drift
   * Inbox mount — the agent summarizes open drift and suggests next actions. The
   * `seed` is the greet-only instruction (built in scaffold-sourced prose by the
   * OpeningDriftController). No-ops outside drift mode and after the first fire.
   */
  startDriftOpeningTurn: (seed: string) => void;
  sendMessage: (text: string) => void;
  stopStreaming: () => void;
  respondToUiTool: (toolId: string, result: string) => void;
  addContextChip: (chip: ContextChip) => void;
  removeContextChip: (id: string) => void;
  clearChat: () => void;
  setDoc: (doc: DocWithGraph | null) => void;
  setDocId: (id: string | null) => void;
  setOpenCommentCount: (count: number) => void;
}

const ChatContext = createContext<ChatState | null>(null);

let messageIdCounter = 0;
function nextId(): string {
  return `msg-${++messageIdCounter}`;
}

export function ChatProvider({ children }: { children: ReactNode }) {
  const { token } = useAuth();

  // Sync auth token to all clients
  setLlmAuthToken(token);
  setToolAuthToken(token);
  setConversationAuthToken(token);

  const { invoke, resume } = useAgentGraph();

  const [docId, setDocIdState] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contextChips, setContextChips] = useState<ContextChip[]>([]);
  const [doc, setDoc] = useState<DocWithGraph | null>(null);
  const [openCommentCount, setOpenCommentCount] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const [respondedToolIds, setRespondedToolIds] = useState<Set<string>>(new Set());
  const docIdRef = useRef<string | null>(null);
  // spec-143 t-4 (dec-6): the agent mode. State drives the UI (ChatPanel's
  // input-enable check via isDriftMode); the ref mirrors it so the async
  // sendMessage / startDriftOpeningTurn closures read the current mode without
  // re-subscribing to it (same pattern as docIdRef). Default 'spec'.
  const [agentMode, setAgentModeState] = useState<'spec' | 'drift'>('spec');
  const agentModeRef = useRef<'spec' | 'drift'>('spec');
  // Track Anthropic-format messages for the graph
  const anthropicMessagesRef = useRef<MessageParam[]>([]);
  // Id of the placeholder assistant message for the CURRENT streaming turn.
  // Null when no turn is in-flight or the turn was just rebuilt. Cleared on
  // every onAssistantTurnComplete so each turn in a multi-turn graph run gets
  // its own placeholder.
  const streamingAssistantIdRef = useRef<string | null>(null);
  // spec-143 t-4 (dec-6) — guards the drift agent's on-mount opening turn so it
  // fires at most ONCE per drift-mode entry (the controller effect can re-run;
  // the drift agent must NOT be invoked as a side effect more than once). Reset
  // to null on docId change and on drift enter/exit. (spec-159: the Spec on-open
  // greeting that also used this ref was removed — opening a Spec no longer
  // auto-activates the agent; only the Drift Inbox uses this now.)
  const openingTurnStartedForRef = useRef<string | null>(null);

  const setDocId = useCallback((id: string | null) => {
    if (id === docIdRef.current) return;
    docIdRef.current = id;
    setDocIdState(id);
    abortRef.current?.abort();
    setMessages([]);
    setError(null);
    setContextChips([]);
    setRespondedToolIds(new Set());
    anthropicMessagesRef.current = [];
    openingTurnStartedForRef.current = null;
  }, []);

  // spec-143 t-4 (dec-6): enter / leave drift mode. Entering wipes any prior
  // doc-bound thread (the drift agent is a fresh, memex-scoped conversation) and
  // unbinds docId so the gate / graph treat it as drift, not a doc chat. Leaving
  // resets to the default 'spec' agent and clears the thread again. Both update
  // the ref synchronously so the async send / opening-turn closures read the
  // current mode immediately. enterDriftMode is idempotent — re-entering doesn't
  // wipe an in-flight drift conversation.
  const enterDriftMode = useCallback(() => {
    if (agentModeRef.current === 'drift') return;
    agentModeRef.current = 'drift';
    setAgentModeState('drift');
    docIdRef.current = null;
    setDocIdState(null);
    abortRef.current?.abort();
    setMessages([]);
    setError(null);
    setContextChips([]);
    setRespondedToolIds(new Set());
    anthropicMessagesRef.current = [];
    openingTurnStartedForRef.current = null;
  }, []);

  const exitDriftMode = useCallback(() => {
    if (agentModeRef.current === 'spec') return;
    agentModeRef.current = 'spec';
    setAgentModeState('spec');
    abortRef.current?.abort();
    setMessages([]);
    setError(null);
    setContextChips([]);
    setRespondedToolIds(new Set());
    anthropicMessagesRef.current = [];
    openingTurnStartedForRef.current = null;
  }, []);

  // Hard-reset the conversation on every Spec open.
  //
  // Opening a Spec is a fresh chat: the thread is wiped and starts empty. We
  // deliberately do NOT restore the prior stored conversation. `setDocId`
  // already cleared the LOCAL state (messages, anthropicMessagesRef, etc.)
  // synchronously when docId changed; here we also clear the REMOTE store so a
  // later reopen stays clean.
  //
  // spec-159: the agent is NOT invoked on open — opening a Spec no longer
  // auto-activates the agent. The chat sits idle until the user types or clicks
  // a prompt; the page itself carries phase, readiness, handoffs, and reviewer
  // affordances.
  useEffect(() => {
    if (!docId) return;
    clearConversationRemote(docId).catch(console.error);
  }, [docId]);

  /**
   * Build AgentCallbacks that update ChatMessage[] state in real-time.
   * Placeholders for streamed text are created lazily (on the first text_delta
   * of a turn) via streamingAssistantIdRef so every turn in a multi-turn graph
   * run gets its own placeholder.
   */
  const makeCallbacks = useCallback(
    (): AgentCallbacks => ({
      onTextDelta: (text: string) => {
        // Pin the target message id at CALL time, before setMessages runs. The
        // functional updater below is queued and runs asynchronously — by the
        // time React executes it, onAssistantTurnComplete may have already
        // reset streamingAssistantIdRef.current to null (the last delta of a
        // turn lands in the same microtask batch as message_complete), and
        // reading the ref inside the updater would then spawn a new message
        // and silently drop that final token.
        let targetId = streamingAssistantIdRef.current;
        if (!targetId) {
          targetId = nextId();
          streamingAssistantIdRef.current = targetId;
        }
        setMessages((prev) => {
          if (prev.some((m) => m.id === targetId)) {
            return prev.map((m) =>
              m.id === targetId ? { ...m, content: m.content + text } : m
            );
          }
          return [
            ...prev,
            { id: targetId, role: 'assistant', content: text, timestamp: new Date() },
          ];
        });
      },
      onToolStart: (toolName: string, toolId: string) => {
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: 'tool_status',
            content: `Running ${toolName}...`,
            toolName,
            toolId,
            timestamp: new Date(),
          },
        ]);
      },
      onToolResult: (toolId: string, result: string) => {
        // Tool results are agent-facing prompts: the outcome sentence leads,
        // and nudges ("call create_ac({…})", ref dumps) start after the first
        // blank line per the tool-specs.ts convention. Show the human only
        // the leading chunk; keep errors verbatim so failures stay visible —
        // the same error contract NewSpecModal pinned. (spec-157 dec-1)
        const display = result.startsWith('Error:')
          ? result
          : result.split('\n\n', 1)[0];
        setMessages((prev) =>
          prev.map((m) =>
            m.toolId === toolId && m.role === 'tool_status'
              ? { ...m, content: display }
              : m
          )
        );
      },
      onAssistantTurnComplete: (content) => {
        const currentId = streamingAssistantIdRef.current;
        streamingAssistantIdRef.current = null;

        const hasUiTool = content.some(
          (b) => b.type === 'tool_use' && UI_TOOL_NAMES.has(b.name)
        );
        if (!hasUiTool) return; // Pure-text turn — placeholder already has correct content.

        const rebuilt: ChatMessage[] = [];
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            rebuilt.push({
              id: nextId(),
              role: 'assistant',
              content: block.text,
              timestamp: new Date(),
            });
          } else if (block.type === 'tool_use' && UI_TOOL_NAMES.has(block.name)) {
            rebuilt.push({
              id: nextId(),
              role: 'ui_tool',
              content: '',
              toolName: block.name,
              toolId: block.id,
              toolInput: block.input,
              timestamp: new Date(),
            });
          }
        }

        setMessages((prev) => {
          if (!currentId) return [...prev, ...rebuilt];
          const idx = prev.findIndex((m) => m.id === currentId);
          if (idx === -1) return [...prev, ...rebuilt];
          return [...prev.slice(0, idx), ...rebuilt, ...prev.slice(idx + 1)];
        });
      },
      onDocCreated: () => {
        // Don't set docId or navigate — let the user stay on the creation page.
        // The agent stays in creation phase until the user navigates to the doc.
      },
    }),
    []
  );

  const sendMessage = useCallback(
    async (text: string) => {
      if (isStreaming) return;
      const currentDocId = docIdRef.current;

      setError(null);
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: 'user', content: text, timestamp: new Date() },
      ]);

      setIsStreaming(true);
      streamingAssistantIdRef.current = null;
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const result = await invoke({
          userMessage: text,
          docId: currentDocId,
          contextChips,
          existingMessages: anthropicMessagesRef.current,
          agentMode: agentModeRef.current,
          callbacks: makeCallbacks(),
          signal: controller.signal,
        });

        anthropicMessagesRef.current = result.messages;

        // Background save — use result.docId which may have been set during creation.
        // spec-143 t-4 (dec-6): drift mode has no bound doc, so there's nothing to
        // persist a per-doc conversation against — skip the save in that case.
        const saveDocId = result.docId ?? currentDocId;
        if (saveDocId && agentModeRef.current !== 'drift') {
          saveConversation(saveDocId, result.messages).catch(console.error);
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [isStreaming, contextChips, invoke, makeCallbacks]
  );

  // spec-143 t-4 (dec-6): the drift agent's opening turn — the memex-scoped drift
  // agent streams a greeting on Drift Inbox mount: no bound doc, no per-doc
  // conversation save. Fires at most once per drift-mode entry — guarded by
  // openingTurnStartedForRef (keyed 'drift'), which enterDriftMode resets. The
  // seed is sent as the agent's user message but never shown as a user bubble. On
  // mount the agent summarizes the open drift and suggests next actions (the seed
  // instructs it to greet only).
  const startDriftOpeningTurn = useCallback(
    async (seed: string) => {
      if (agentModeRef.current !== 'drift') return;
      const guardKey = 'drift';
      if (openingTurnStartedForRef.current === guardKey) return;
      if (isStreaming) return;
      openingTurnStartedForRef.current = guardKey;

      setError(null);
      setIsStreaming(true);
      streamingAssistantIdRef.current = null;
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const result = await invoke({
          userMessage: seed,
          docId: null,
          existingMessages: [],
          agentMode: 'drift',
          callbacks: makeCallbacks(),
          signal: controller.signal,
        });
        anthropicMessagesRef.current = result.messages;
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (abortRef.current === controller) {
          setIsStreaming(false);
          abortRef.current = null;
        }
      }
    },
    [isStreaming, invoke, makeCallbacks],
  );

  const respondToUiTool = useCallback(
    async (toolId: string, result: string) => {
      const currentDocId = docIdRef.current;
      if (respondedToolIds.has(toolId)) return;
      setRespondedToolIds((prev) => new Set(prev).add(toolId));

      const currentMessages = anthropicMessagesRef.current;
      const lastMsg = currentMessages[currentMessages.length - 1];

      // Get ALL tool_use blocks from the last assistant message.
      // Anthropic requires a tool_result for every tool_use in one user message.
      const allToolUseBlocks = (
        Array.isArray(lastMsg?.content) ? lastMsg.content : []
      ).filter((b): b is ToolUseBlock => (b as ContentBlock).type === 'tool_use');

      const toolResultBlocks: ContentBlock[] = [];

      for (const block of allToolUseBlocks) {
        if (block.id === toolId) {
          // This is the UI tool the user responded to
          toolResultBlocks.push({
            type: 'tool_result' as const,
            tool_use_id: block.id,
            content: result,
          });
        } else if (DISPLAY_UI_TOOL_NAMES.has(block.name)) {
          // Display-only sibling: synthesise an empty result so the round-trip is valid.
          toolResultBlocks.push({
            type: 'tool_result' as const,
            tool_use_id: block.id,
            content: 'displayed',
          });
        } else if (!UI_TOOL_NAMES.has(block.name)) {
          // Server tool — execute it now (mixed server+UI case). spec-143 t-4
          // (dec-6): forward drift mode + docId so a confirmed drift mutation
          // (e.g. flag_drift after render_confirmation) runs on the drift surface.
          const toolMode = agentModeRef.current === 'drift' ? 'drift' : undefined;
          try {
            const serverResult = await executeToolRemote(
              block.name,
              block.input,
              undefined,
              currentDocId ?? undefined,
              toolMode,
            );
            toolResultBlocks.push({
              type: 'tool_result' as const,
              tool_use_id: block.id,
              content: serverResult,
            });
          } catch (err) {
            toolResultBlocks.push({
              type: 'tool_result' as const,
              tool_use_id: block.id,
              content: `Error: ${err instanceof Error ? err.message : String(err)}`,
              is_error: true,
            });
          }
        }
        // Other interactive UI tools (if any) are skipped — only one active at a time
      }

      const messagesWithResult: MessageParam[] = [
        ...currentMessages,
        { role: 'user' as const, content: toolResultBlocks },
      ];

      setIsStreaming(true);
      streamingAssistantIdRef.current = null;
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const result = await resume({
          docId: currentDocId,
          messages: messagesWithResult,
          agentMode: agentModeRef.current,
          callbacks: makeCallbacks(),
          signal: controller.signal,
        });

        anthropicMessagesRef.current = result.messages;

        // Background save — use result.docId which may have been set during creation.
        // spec-143 t-4 (dec-6): drift mode has no bound doc — skip the per-doc save.
        const saveDocId = result.docId ?? currentDocId;
        if (saveDocId && agentModeRef.current !== 'drift') {
          saveConversation(saveDocId, result.messages).catch(console.error);
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [resume, makeCallbacks, respondedToolIds]
  );

  // Only one focus at a time. Clicking a different section/decision/task
  // replaces the previous one — the user is referring to one thing per
  // message, not building a basket of references. Clicking the same chip
  // again toggles it off.
  const addContextChip = useCallback((chip: ContextChip) => {
    setContextChips((prev) => {
      if (prev.length === 1 && prev[0].id === chip.id) return [];
      return [chip];
    });
  }, []);

  const removeContextChip = useCallback((id: string) => {
    setContextChips((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
  }, []);

  const clearChat = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setError(null);
    setContextChips([]);
    setRespondedToolIds(new Set());
    anthropicMessagesRef.current = [];
    const currentDocId = docIdRef.current;
    if (currentDocId) {
      clearConversationRemote(currentDocId).catch(console.error);
    }
  }, []);

  return (
    <ChatContext.Provider
      value={{
        messages,
        isStreaming,
        error,
        contextChips,
        doc,
        docId,
        openCommentCount,
        respondedToolIds,
        isDriftMode: agentMode === 'drift',
        enterDriftMode,
        exitDriftMode,
        startDriftOpeningTurn,
        sendMessage,
        stopStreaming,
        respondToUiTool,
        addContextChip,
        removeContextChip,
        clearChat,
        setDoc,
        setDocId,
        setOpenCommentCount,
      }}
    >
      {children}
    </ChatContext.Provider>
  );
}

export function useChat() {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChat must be used within ChatProvider');
  return ctx;
}
