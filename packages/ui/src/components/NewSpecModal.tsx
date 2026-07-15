import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Alert } from './ui/Alert';
import { useNavigate } from 'react-router-dom';
import { tenantPath } from '../utils/tenantUrl';
import { useAgentGraph } from '../agent/useAgentGraph';
import type { AgentCallbacks } from '../agent/graph';
import type { ContentBlock, MessageParam, ToolUseBlock } from '../agent/types';
import { UI_TOOL_NAMES, DISPLAY_UI_TOOL_NAMES, INTERACTIVE_UI_TOOL_NAMES } from '../agent/types';
import { executeToolRemote } from '../agent/tool-client';
import type { ChatMessage } from '../api/types';
import { Button } from './ui';
import { TextArea } from './ui/TextArea';
import { ChatMarkdown } from './chat/ChatMarkdown';
import { UiToolRenderer } from './chat/ui-tools';

const PASTE_ATTACHMENT_THRESHOLD = 1500;

interface NewSpecModalProps {
  open: boolean;
  onClose: () => void;
  /**
   * spec-158 t-5: open the modal pre-seeded from an Issue (the Issues page's
   * "Convert to Spec" action). `title` + `body` prefill the composer so the user
   * can elaborate before sending; `promoteFromIssueRef` is the Issue's canonical
   * ref, threaded into the create instruction so creation routes through
   * create_doc's promoteFromIssueRef (which parents the new Spec to the Issue's
   * source Spec and flips the Issue → converted server-side). When absent the
   * modal is the plain blank-slate New Spec flow.
   */
  prefill?: {
    title: string;
    body: string;
    promoteFromIssueRef: string;
  };
  /**
   * spec-158 t-5: fires on a CONFIRMED create (the onDocCreated detection event),
   * so a caller that opened the modal to convert an Issue can refetch its list —
   * the Issue's converted flip is the server's doing, the UI just reloads. Never
   * fires on close/abandon or a failed create. Carries the created doc's
   * handle/title so the caller can confirm the outcome to the user.
   */
  onCreated?: (info: { docId: string; handle: string; title: string }) => void;
  /**
   * spec-470 dec-4: the new-home hero hands its typed sentence off to the
   * create-spec agent with ZERO extra click. When `autoSend` is set and
   * `seedMessage` is non-empty, the open effect composes an agent instruction
   * from the sentence (mirroring handleExplainSpec's composed-instruction
   * pattern — NOT the raw title/body concat used by `prefill`) and calls
   * `dispatchMessage` directly, so the agent starts drafting immediately. The
   * raw sentence shows as the user's first bubble; the composed wrapper stays
   * agent-facing. Empty/whitespace neither opens nor dispatches. `prefill` takes
   * precedence — the two paths never both fire.
   */
  seedMessage?: string;
  autoSend?: boolean;
  /**
   * spec-473 dec-3: how to FRAME the auto-sent seed to the create-spec agent.
   * - `'idea'` (default) — the spec-470 path: `seedMessage` is a one-sentence idea,
   *   wrapped by composeSeedInstruction as "here's my idea… draft it with me".
   * - `'document'` — the new-home IMPORT hero (spec-473): `seedMessage` is an
   *   EXISTING document (pasted or read from an uploaded markdown file). It is
   *   wrapped by composeDocumentInstruction as "convert this existing document into
   *   a structured Spec — sections, decisions, ACs as rows", carrying the document
   *   inline (the shape the server creation prompt is tuned for, spec-230) and
   *   riding as the collapsible attachment. The raw document is NOT shown verbatim
   *   as the user bubble (a short label is), matching the paste UX. The server
   *   creation path is UNCHANGED — this is a pure client framing seam.
   */
  seedKind?: 'idea' | 'document';
  /**
   * spec-470: the tenant-prefixed Specs-board path (e.g. `/alice/personal/specs`) of
   * the memex the agent creates in. When the modal opens from a FLAT route (the /home
   * hero) the URL carries no tenant, so the internal `tenantPath()` can't prefix the
   * created Spec's URL — it would yield an unroutable `/specs/{handle}`. The caller
   * passes this so post-create navigation lands on `${specsBasePath}/${handle}`.
   * Omitted → falls back to `tenantPath()`, so the tenant-route callers (e.g. Issue
   * conversion from the Issues page) are unchanged.
   */
  specsBasePath?: string;
  /**
   * spec-473 hotfix: the tenant API base (`/api/<ns>/<mx>`) of the memex the agent
   * should create in. The /home hero opens this modal from a FLAT `/home` URL, so
   * the agent clients' ambient tenantBase() would resolve to `currentMemexId` from
   * localStorage — possibly a stale/foreign memex the server 404s (std-7). Passing
   * the personal-memex base pins creation (the /chat/create call AND its create_doc /
   * add_section tool executions) to the same memex `specsBasePath` navigates to.
   * Omitted → the agent resolves the tenant from the URL, unchanged for board callers.
   */
  creationTenantBasePath?: string;
  /**
   * spec-470: navigate straight to the Spec the instant it's created — no "Open Spec"
   * click. This delivers the hero's Lovable-style "describe it → land on your Spec"
   * flow (ac-2), AND it is load-bearing: the hero renders on /home only while
   * `hasSpec` is false, so creating the Spec flips that milestone and HomeCanvas
   * unmounts the hero (which owns this modal) the moment the create commits. Leaving
   * /home on create wins that race — the manual "Open Spec" button would never be
   * clickable. The board/Issues callers omit this and keep the manual button.
   */
  openOnCreate?: boolean;
}

// spec-470 dec-4: wrap the hero's raw sentence in a short agent-facing
// instruction (the handleExplainSpec composed-instruction pattern), so the
// agent drafts a spec from it rather than treating it as a bare title.
function composeSeedInstruction(sentence: string): string {
  return `I want to build something new. Here's my idea in one sentence:\n\n"${sentence}"\n\nHelp me turn this into a spec — draft it with me, asking anything you need to.`;
}

// spec-473 dec-3: the new-home IMPORT hero hands over an EXISTING document (pasted
// or read from an uploaded markdown file). Frame it as "convert this document into a
// STRUCTURED Spec" — sections, decisions, and ACs as first-class rows — carrying the
// document inline under the same "--- ... ---" delimiter shape the paste path
// (handleSend) uses, which the server creation prompt is already tuned for (spec-230).
// The server path is unchanged; this is a pure client framing seam.
function composeDocumentInstruction(document: string): string {
  return `I have an existing document — a spec or PRD written in markdown. Convert it into a well-structured Spec: capture its sections, decisions, and acceptance criteria as first-class rows (and tasks where the source implies them), not a thin overview.\n\n--- Document to convert ---\n${document}`;
}

let messageIdCounter = 0;
const nextId = () => `new-spec-${++messageIdCounter}`;

function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function firstLinePreview(text: string, maxChars = 80): string {
  const firstNonEmpty = text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? '';
  if (firstNonEmpty.length <= maxChars) return firstNonEmpty;
  return firstNonEmpty.slice(0, maxChars - 1).trimEnd() + '…';
}

function AttachmentPill({
  content,
  onRemove,
  compact = false,
}: {
  content: string;
  onRemove?: () => void;
  compact?: boolean;
}) {
  const words = countWords(content);
  const size = humanBytes(new Blob([content]).size);
  const preview = firstLinePreview(content);

  return (
    <div
      className={`inline-flex items-start gap-2.5 rounded-lg border border-edge-subtle bg-overlay ${
        compact ? 'px-2.5 py-1.5' : 'px-3 py-2'
      } max-w-full`}
    >
      <svg
        className="w-4 h-4 mt-0.5 flex-none text-muted"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M7 3h8l4 4v14a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 3v4h4" />
      </svg>
      <div className="min-w-0">
        <div className="text-xs font-medium text-primary">
          Pasted content
          <span className="text-muted font-normal"> · {words.toLocaleString()} words · {size}</span>
        </div>
        {preview && (
          <div className="text-xs text-muted truncate mt-0.5 max-w-[480px]">{preview}</div>
        )}
      </div>
      {onRemove && (
        <button
          onClick={onRemove}
          className="flex-none ml-1 text-muted hover:text-primary"
          title="Remove attachment"
          type="button"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  );
}

type DisplayMessage =
  | (ChatMessage & { attachment?: string })
  | {
      id: string;
      role: 'doc_created';
      content: string;
      docId: string;
      handle: string;
      title: string;
      timestamp: Date;
    };

export function NewSpecModal({ open, onClose, prefill, onCreated, seedMessage, autoSend, seedKind = 'idea', specsBasePath, creationTenantBasePath, openOnCreate }: NewSpecModalProps) {
  const { invoke, resume } = useAgentGraph();

  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [pastedContent, setPastedContent] = useState<string | null>(null);
  const [respondedToolIds, setRespondedToolIds] = useState<Set<string>>(new Set());

  const anthropicMessagesRef = useRef<MessageParam[]>([]);
  // spec-158 t-5: the Issue's canonical ref while converting an Issue → Spec.
  // Threaded into every create instruction this session so the agent calls
  // create_doc with promoteFromIssueRef (the seam that flips the Issue →
  // converted server-side). Held in a ref so it survives the user editing the
  // composer before sending; null in the plain New Spec flow.
  const promoteFromIssueRefRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Id of the placeholder assistant message being streamed into for the current
  // turn. null when no turn is in-flight. Reset on every onAssistantTurnComplete
  // so each turn in a multi-turn graph run gets its own placeholder.
  const streamingAssistantIdRef = useRef<string | null>(null);
  // spec-470 dec-4: guards the auto-send so a seeded open dispatches exactly once
  // (dispatchMessage's identity changing must not re-fire it). Reset when closed.
  const autoSentRef = useRef(false);

  const resetState = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    anthropicMessagesRef.current = [];
    promoteFromIssueRefRef.current = null;
    streamingAssistantIdRef.current = null;
    setMessages([]);
    setIsStreaming(false);
    setError(null);
    setInput('');
    setPastedContent(null);
    setRespondedToolIds(new Set());
  }, []);

  useEffect(() => {
    if (open) {
      resetState();
      // spec-158 t-5: when opened to convert an Issue, seed the composer with the
      // Issue's content (title + body) so the user can elaborate, and stash the
      // Issue ref so the eventual create instruction carries promoteFromIssueRef.
      if (prefill) {
        promoteFromIssueRefRef.current = prefill.promoteFromIssueRef;
        const seeded = prefill.body.trim()
          ? `${prefill.title.trim()}\n\n${prefill.body.trim()}`
          : prefill.title.trim();
        setInput(seeded);
      }
      setTimeout(() => textareaRef.current?.focus(), 0);
    } else {
      abortRef.current?.abort();
      abortRef.current = null;
      // spec-470 dec-4: re-arm the auto-send guard so the next seeded open fires.
      autoSentRef.current = false;
    }
  }, [open, resetState, prefill]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const navigate = useNavigate();

  const handleClose = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    onClose();
  }, [onClose]);

  // spec-230 t-3: the in-app creation flow now fleshes out the whole Spec, so
  // the user's natural next move is to land ON the populated Spec — not hunt for
  // it on the Kanban. Close the modal and navigate to the Spec page (in-Spec
  // chat) so they can keep refining it.
  const openSpec = useCallback(
    (handle: string) => {
      handleClose();
      // spec-470: from the flat /home hero the URL carries no tenant, so
      // tenantPath() would yield an unroutable /specs/{handle}. When the caller
      // supplies the created memex's Specs-board base, navigate under it; else fall
      // back to tenantPath() (tenant-route callers, e.g. Issue conversion).
      // spec-482 (t-7): tag this navigation as the creation→landing hop via React
      // Router `state`, so the destination Spec view auto-sends the landing recap
      // opening turn and shows the post-creation handoff card. Only THIS create-and-
      // open path carries the flag — a normal in-app open of an existing Spec omits it.
      navigate(specsBasePath ? `${specsBasePath}/${handle}` : tenantPath(`/specs/${handle}`), {
        state: { creationLanding: true },
      });
    },
    [handleClose, navigate, specsBasePath]
  );

  // spec-470: openOnCreate callers (the /home hero) land on the Spec the instant it's
  // created — no "Open Spec" click. Fires once, on the single-created handle, as soon as
  // the create commits (not gated on stream end), so it delivers the "land on your Spec"
  // flow (ac-2). MUST live above the modal's early returns — a conditional hook here
  // crashes the component the moment it opens (spec-470 e2e caught exactly that).
  const navigatedOnCreateRef = useRef(false);
  useEffect(() => {
    if (!openOnCreate || navigatedOnCreateRef.current) return;
    const created = messages.filter((m) => m.role === 'doc_created');
    if (created.length !== 1) return;
    // spec-473: a DOCUMENT import keeps authoring AFTER create_doc — the agent runs
    // add_section / create_decision / create_ac to restructure the source into a rich
    // Spec. Navigating on the first create_doc (spec-470's idea-path behaviour) would
    // unmount this modal and ABORT that authoring stream, leaving a thin Overview-only
    // Spec (the very failure the import pivot exists to fix). So for seedKind='document'
    // wait until the whole stream has finished before landing on the now-populated Spec.
    // The hero-vs-tracker FREEZE (HomeCanvas) keeps the hero — and this modal — mounted
    // across the create's hasSpec flip, so there is no graduation-unmount race to beat by
    // navigating early. The idea path still lands the instant it's created (its stream
    // ends at create_doc anyway).
    if (seedKind === 'document' && isStreaming) return;
    navigatedOnCreateRef.current = true;
    openSpec(created[0].handle);
  }, [openOnCreate, messages, isStreaming, seedKind, openSpec]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, handleClose]);

  const makeCallbacks = useCallback(
    (): AgentCallbacks => ({
      onTextDelta: (text) => {
        // Pin the target id at CALL time, not inside the functional updater.
        // The last delta of a turn and the onAssistantTurnComplete that nulls
        // this ref land in the same microtask batch — reading the ref inside
        // a queued updater would then spawn a stray new message and drop the
        // final token on the floor. See matching comment in ChatContext.tsx.
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
      // spec-473: the live "Building your Spec…" checklist. Fires as the model
      // finishes WRITING each tool block during the batched authoring turn (before
      // execution), so rows tick in during the wait instead of dumping at the end.
      // UI tools render via onAssistantTurnComplete — skip them here. Upsert by
      // toolId so the later onToolStart/onToolResult update this same row.
      onToolProgress: (toolName, toolId, label) => {
        if (UI_TOOL_NAMES.has(toolName)) return;
        setMessages((prev) => {
          if (prev.some((m) => m.role === 'tool_status' && m.toolId === toolId)) {
            return prev.map((m) =>
              m.role === 'tool_status' && m.toolId === toolId
                ? { ...m, content: `✓ ${label}` }
                : m
            );
          }
          return [
            ...prev,
            {
              id: nextId(),
              role: 'tool_status',
              content: `✓ ${label}`,
              toolName,
              toolId,
              timestamp: new Date(),
            },
          ];
        });
      },
      onToolStart: (toolName, toolId) => {
        setMessages((prev) => {
          // spec-473: onToolProgress may have already created this row as the block
          // was written — don't duplicate it at execution time.
          if (prev.some((m) => m.role === 'tool_status' && m.toolId === toolId)) {
            return prev;
          }
          return [
            ...prev,
            {
              id: nextId(),
              role: 'tool_status',
              content: `Running ${toolName}...`,
              toolName,
              toolId,
              timestamp: new Date(),
            },
          ];
        });
      },
      onToolResult: (toolId, result) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.role === 'tool_status' && m.toolId === toolId
              ? {
                  ...m,
                  // Errors stay visible verbatim (raw results are agent-facing
                  // prose, spec-155 i-1). On success: if onToolProgress already
                  // wrote a "✓ …" checklist label (the spec-473 batched-authoring
                  // path), keep it — execution is near-instant so re-labelling
                  // would just churn. Otherwise the row is still the onToolStart
                  // "Running …" placeholder, so collapse it to a "Ran …" done
                  // marker (spec-155 i-1 — never leave it reading as in-flight).
                  content: result.startsWith('Error:')
                    ? result
                    : m.content.startsWith('Running ')
                      ? `Ran ${m.toolName}`
                      : m.content,
                }
              : m
          )
        );
      },
      onAssistantTurnComplete: (content) => {
        // Each turn of a multi-turn graph run gets its own placeholder.
        // Capture + reset the ref before we rebuild so the NEXT turn's
        // onTextDelta creates a fresh placeholder.
        const currentId = streamingAssistantIdRef.current;
        streamingAssistantIdRef.current = null;

        const hasUiTool = content.some(
          (b) => b.type === 'tool_use' && UI_TOOL_NAMES.has(b.name)
        );

        // Pure-text turn: the streamed placeholder already has everything. Keep it.
        if (!hasUiTool) return;

        // Build the ordered replacement: text + ui_tool messages in block order.
        const rebuilt: DisplayMessage[] = [];
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
          // Server tool_use blocks are surfaced via onToolStart/Result, not here.
        }

        setMessages((prev) => {
          if (!currentId) {
            // No streamed text this turn (agent jumped straight to a UI tool).
            return [...prev, ...rebuilt];
          }
          const idx = prev.findIndex((m) => m.id === currentId);
          if (idx === -1) return [...prev, ...rebuilt];
          return [...prev.slice(0, idx), ...rebuilt, ...prev.slice(idx + 1)];
        });
      },
      onDocCreated: (info) => {
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: 'doc_created',
            content: '',
            docId: info.docId,
            handle: info.handle,
            title: info.title,
            timestamp: new Date(),
          },
        ]);
        // spec-158 t-5: a CONFIRMED create is the only signal a caller (the
        // Issues page converting an Issue) acts on — the Issue's converted flip
        // is the server's promoteFromIssueRef path, the UI just refetches. Fires
        // only here, never on close/abandon or a failed create.
        onCreated?.(info);
      },
    }),
    [onCreated]
  );

  const dispatchMessage = useCallback(
    async (params: { composed: string; displayText: string; attachment?: string }) => {
      setError(null);

      setMessages((prev) => [
        ...prev,
        {
          id: nextId(),
          role: 'user',
          content: params.displayText,
          attachment: params.attachment,
          timestamp: new Date(),
        },
      ]);

      setIsStreaming(true);
      streamingAssistantIdRef.current = null;
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const result = await invoke({
          userMessage: params.composed,
          docId: null,
          existingMessages: anthropicMessagesRef.current,
          callbacks: makeCallbacks(),
          signal: controller.signal,
          tenantBasePath: creationTenantBasePath,
        });
        anthropicMessagesRef.current = result.messages;
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [invoke, makeCallbacks, creationTenantBasePath]
  );

  // spec-470 dec-4: auto-send the hero's seeded sentence on open. Runs AFTER the
  // reset effect above (later effect = later in the commit), so state is already
  // cleared; guarded to fire exactly once per open. `prefill` wins — the two
  // seeding paths never both fire. Placed below dispatchMessage so it's in scope.
  useEffect(() => {
    if (!open || prefill || !autoSend) return;
    const seed = seedMessage?.trim();
    if (!seed) return; // empty/whitespace neither opens nor dispatches
    if (autoSentRef.current) return;
    autoSentRef.current = true;
    if (seedKind === 'document') {
      // spec-473: an imported document — frame it as "convert this into a Spec"
      // and show a short label (not the whole document) as the user bubble, with
      // the document riding as the collapsible attachment (mirrors the paste UX).
      void dispatchMessage({
        composed: composeDocumentInstruction(seed),
        displayText: 'Turn this document into a Spec.',
        attachment: seed,
      });
    } else {
      void dispatchMessage({
        composed: composeSeedInstruction(seed),
        displayText: seed,
      });
    }
  }, [open, prefill, autoSend, seedKind, seedMessage, dispatchMessage]);

  const handleSend = useCallback(async () => {
    if (isStreaming) return;

    const typed = input.trim();
    const paste = pastedContent;
    if (!typed && !paste) return;

    let composed: string;
    if (paste) {
      const lead = typed || 'Use the pasted content below as the basis for the spec:';
      composed = `${lead}\n\n--- Pasted reference content ---\n${paste}`;
    } else {
      composed = typed;
    }

    // spec-158 t-5: converting an Issue → Spec. Append an explicit, agent-facing
    // instruction so create_doc is called with promoteFromIssueRef — that's the
    // server seam that parents the new Spec to the Issue's source Spec and flips
    // the Issue → converted. Kept out of displayText so it never reaches the human.
    const issueRef = promoteFromIssueRefRef.current;
    if (issueRef) {
      composed = `${composed}\n\n--- (system) ---\nThis Spec is being promoted from an existing Issue. When you call create_doc, pass promoteFromIssueRef: "${issueRef}" so the new Spec is parented to the Issue's source Spec and the Issue is converted.`;
    }

    const displayText = typed || (paste ? 'Use the pasted content as the basis for the spec.' : '');

    setInput('');
    setPastedContent(null);

    await dispatchMessage({
      composed,
      displayText,
      attachment: paste ?? undefined,
    });
  }, [isStreaming, input, pastedContent, dispatchMessage]);

  const handleExplainSpec = useCallback(() => {
    if (isStreaming) return;
    void dispatchMessage({
      composed:
        "Before we draft anything, please explain what a spec document is in Memex — what it should cover, what a good one looks like, and how it turns into decisions and tasks. Reference the spec-document skill. Once you've explained, continue on and help me create one.",
      displayText: 'Explain what a spec is to me',
    });
  }, [isStreaming, dispatchMessage]);

  const respondToUiTool = useCallback(
    async (toolId: string, result: string) => {
      if (respondedToolIds.has(toolId)) return;

      const currentMessages = anthropicMessagesRef.current;
      const lastMsg = currentMessages[currentMessages.length - 1];
      const toolUseBlocks = (
        Array.isArray(lastMsg?.content) ? lastMsg.content : []
      ).filter((b): b is ToolUseBlock => (b as ContentBlock).type === 'tool_use');

      // Guard: the toolId the user clicked MUST be in the last assistant turn's
      // tool_use blocks. If it isn't, anthropicMessagesRef is stale (e.g. the
      // user clicked a UI tool that appeared mid-stream before the ref was
      // updated). Surface a clear error instead of sending a bogus request.
      if (!toolUseBlocks.some((b) => b.id === toolId)) {
        setError(
          'Could not send your choice because the chat is still streaming. Please wait for it to finish and try again.'
        );
        return;
      }

      setRespondedToolIds((prev) => new Set(prev).add(toolId));

      const toolResultBlocks: ContentBlock[] = [];
      for (const block of toolUseBlocks) {
        if (block.id === toolId) {
          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result,
          });
        } else if (DISPLAY_UI_TOOL_NAMES.has(block.name)) {
          // Display-only UI tools that happen to sit alongside an interactive one:
          // synthesise an empty result so Anthropic's tool-use round-trip validates.
          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: 'displayed',
          });
        } else if (!UI_TOOL_NAMES.has(block.name)) {
          try {
            const serverResult = await executeToolRemote(block.name, block.input);
            toolResultBlocks.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: serverResult,
            });
          } catch (err) {
            toolResultBlocks.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: `Error: ${err instanceof Error ? err.message : String(err)}`,
              is_error: true,
            });
          }
        }
      }

      const messagesWithResult: MessageParam[] = [
        ...currentMessages,
        { role: 'user', content: toolResultBlocks },
      ];

      setIsStreaming(true);
      streamingAssistantIdRef.current = null;
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const result = await resume({
          docId: null,
          messages: messagesWithResult,
          callbacks: makeCallbacks(),
          signal: controller.signal,
          tenantBasePath: creationTenantBasePath,
        });
        anthropicMessagesRef.current = result.messages;
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [respondedToolIds, resume, makeCallbacks, creationTenantBasePath]
  );

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const text = e.clipboardData.getData('text/plain');
    if (text.length >= PASTE_ATTACHMENT_THRESHOLD) {
      e.preventDefault();
      setPastedContent((prev) => (prev ? `${prev}\n\n${text}` : text));
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const stopStreaming = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
  };

  if (!open) return null;

  const canSend = (input.trim().length > 0 || pastedContent !== null) && !isStreaming;
  const showEmptyState = messages.length === 0;
  // Creation is "done" once we've created at least one doc, streaming has
  // stopped, and no interactive UI tool is waiting on the user. At that point
  // the user's next move is to look at the Kanban — swap the input for Close.
  const createdDocMsgs = messages.filter((m) => m.role === 'doc_created');
  const createdDocCount = createdDocMsgs.length;
  const hasCreatedDoc = createdDocCount > 0;
  // spec-230 t-3: only offer a single-target "Open Spec" when exactly one Spec
  // was created (multi-Spec creation is ambiguous — those land on the Kanban,
  // each card a link).
  const lastCreatedHandle =
    createdDocCount === 1 ? createdDocMsgs[0].handle : undefined;
  const hasPendingInteractiveTool = messages.some(
    (m) =>
      m.role === 'ui_tool' &&
      !!m.toolName &&
      INTERACTIVE_UI_TOOL_NAMES.has(m.toolName) &&
      !!m.toolId &&
      !respondedToolIds.has(m.toolId)
  );
  const creationComplete = hasCreatedDoc && !isStreaming && !hasPendingInteractiveTool;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs"
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div className="w-[720px] h-[80vh] flex flex-col rounded-xl border border-edge bg-panel shadow-2xl">
        <div className="flex items-center justify-between px-5 py-3 border-b border-edge flex-none">
          <h2 className="text-sm font-semibold text-heading">New Spec</h2>
          <button
            onClick={handleClose}
            className="p-1 rounded-md text-muted hover:text-primary hover:bg-overlay transition-colors"
            type="button"
            aria-label="Close"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 min-h-0 space-y-4">
          {showEmptyState && (
            <div className="py-6">
              <h3 className="text-base font-medium text-heading mb-2">
                Describe your spec, or paste content to get started.
              </h3>
              <p className="text-sm text-muted">
                Paste a spec, a short note, or a doc dump below — we&apos;ll turn it into a spec. Or just describe
                what you have in mind in a sentence or two.
              </p>
              <div className="mt-4">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleExplainSpec}
                  disabled={isStreaming}
                >
                  Explain what a spec is to me
                </Button>
              </div>
            </div>
          )}

          {messages.map((msg) => {
            if (msg.role === 'user') {
              return (
                <div key={msg.id} className="flex justify-end">
                  <div className="max-w-[85%] flex flex-col items-end gap-1.5">
                    {msg.attachment && <AttachmentPill content={msg.attachment} compact />}
                    {msg.content && (
                      <div className="px-3 py-2 rounded-lg text-sm bg-surface/50 border border-edge-subtle text-primary">
                        {msg.content}
                      </div>
                    )}
                  </div>
                </div>
              );
            }

            if (msg.role === 'tool_status') {
              return (
                <div key={msg.id} className="text-xs text-muted pl-1">
                  {msg.content}
                </div>
              );
            }

            if (msg.role === 'assistant') {
              if (!msg.content) return null;
              return (
                <div key={msg.id} className="max-w-[95%]">
                  <ChatMarkdown content={msg.content} />
                </div>
              );
            }

            if (msg.role === 'ui_tool' && msg.toolName && msg.toolId && msg.toolInput) {
              return (
                <UiToolRenderer
                  key={msg.id}
                  toolName={msg.toolName}
                  toolId={msg.toolId}
                  input={msg.toolInput}
                  // Disabled while a turn is still in flight — clicking during a
                  // stream would use a stale anthropicMessagesRef and send an
                  // empty tool_result (race against the post-resume snapshot).
                  disabled={isStreaming || respondedToolIds.has(msg.toolId)}
                  onRespond={respondToUiTool}
                />
              );
            }

            if (msg.role === 'doc_created') {
              // spec-230 t-3: the card is the populated Spec — make it a link so
              // the user lands on it (and the in-Spec chat) in one click.
              const handle = msg.handle;
              const card = (
                <>
                  <div className="text-xs text-muted font-mono">{handle}</div>
                  <div className="text-sm font-medium text-heading truncate">{msg.title}</div>
                </>
              );
              return handle ? (
                <button
                  key={msg.id}
                  type="button"
                  onClick={() => openSpec(handle)}
                  // spec-290 t-4: this button previously set status-success-bg at 30% with a
                  // 50%-on-hover opacity modifier, but status-success-bg is a baked-opacity
                  // token, so both modifiers were no-ops in v3 (the hover never rendered).
                  // Stripped to the base token to preserve the v3 render.
                  // FOLLOW-UP: a real hover treatment is needed if hover feedback is wanted.
                  className="block w-full text-left rounded-lg border border-status-success-border bg-status-success-bg px-3 py-2 transition-colors"
                >
                  {card}
                </button>
              ) : (
                <div
                  key={msg.id}
                  className="rounded-lg border border-status-success-border bg-status-success-bg px-3 py-2"
                >
                  {card}
                </div>
              );
            }

            return null;
          })}

          {isStreaming && (
            <div className="flex items-center gap-1.5 text-xs text-muted">
              <svg className="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              Working...
            </div>
          )}

          {error && (
            <Alert variant="danger" size="md">
              {error}
            </Alert>
          )}

          <div ref={messagesEndRef} />
        </div>

        <div className="flex-none px-5 py-4 border-t border-edge space-y-2">
          {creationComplete ? (
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm text-muted">
                {createdDocCount > 1
                  ? 'Your specs are ready — open one to keep refining it.'
                  : 'Your spec is ready — open it to keep refining it.'}
              </div>
              <div className="flex items-center gap-2">
                {/* spec-230 t-3: single-spec → primary "Open Spec" navigates to the
                    populated Spec; the old Close-only state was the dead-end. */}
                {lastCreatedHandle && (
                  <Button onClick={() => openSpec(lastCreatedHandle)}>Open Spec</Button>
                )}
                <Button
                  variant={lastCreatedHandle ? 'secondary' : 'primary'}
                  onClick={handleClose}
                >
                  Close
                </Button>
              </div>
            </div>
          ) : (
            <>
              {pastedContent && (
                <AttachmentPill content={pastedContent} onRemove={() => setPastedContent(null)} />
              )}
              <div className="relative">
                <TextArea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePaste}
                  placeholder={
                    pastedContent
                      ? 'Add instructions (optional), or press Send to use the pasted content.'
                      : 'Describe the spec, or paste a doc here…'
                  }
                  rows={4}
                  className="pb-11"
                />
                <div className="absolute bottom-2 right-2 flex items-center gap-1.5">
                  {isStreaming && (
                    <button
                      onClick={stopStreaming}
                      className="p-1.5 rounded-md border transition-colors border-edge text-secondary hover:border-status-danger-border hover:text-status-danger-text"
                      title="Stop generating"
                      type="button"
                    >
                      <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <rect x="3.5" y="3.5" width="9" height="9" rx="1" />
                      </svg>
                    </button>
                  )}
                  <Button onClick={() => void handleSend()} disabled={!canSend}>
                    Send
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
