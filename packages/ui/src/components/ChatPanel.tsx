import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { toButtonPrompt, BASE_SCAFFOLD } from '@memex/shared';
import { useChat } from './ChatContext';
import { useOrgScaffoldBlocks } from '../hooks/useOrgScaffoldBlocks';
import { ChatMarkdown } from './chat/ChatMarkdown';
import { ContextChipBar } from './chat/ContextChipBar';
import { UiToolRenderer } from './chat/ui-tools';
import { TextArea } from './ui/TextArea';
import { Button } from './ui';
import { PublicAuthButtons } from './PublicAccessControls';

// spec-283: the four Spec review actions, re-homed from the Spec page into the
// agent's idle/empty state (dec-1…dec-4). The prompts are STATIC scaffold text
// (no `{placeholder}` interpolation — see `opening-review-*` in
// scaffold-data.ts), so the agent fires them with `context: {}` and no doc
// context beyond the Org appends, mirroring DocDocument's `sendReviewPrompt`
// direct-injection path. Labels/ids match the page's old REVIEW_ACTIONS.
const REVIEW_ACTIONS: { label: string; buttonId: string }[] = [
  { label: 'Summarise Spec', buttonId: 'opening-review-summarise' },
  { label: 'Security review', buttonId: 'opening-review-security' },
  { label: 'Design review', buttonId: 'opening-review-design' },
  { label: 'Architecture review', buttonId: 'opening-review-architecture' },
];

/**
 * spec-111 t-9 — agent panel access states (dec-2):
 *   - anonymous visitor (`isAuthenticated === false`) → "Sign in to chat"
 *     placeholder, no agent access.
 *   - signed-in non-member (`readOnly === true`) → agent active in read-only
 *     mode (a banner makes the limitation explicit; server-side the MCP gate
 *     blocks mutating tools — t-4).
 *   - org member (defaults) → full read+write agent, unchanged.
 *
 * Both props default so existing org-member call sites stay byte-for-byte the
 * same. The parent (t-8 DocumentShell) passes the real auth/membership values.
 */
export interface ChatPanelProps {
  /** False → anonymous visitor; render the sign-in placeholder. Default true. */
  isAuthenticated?: boolean;
  /** True → signed-in non-member; agent runs read-only. Default false. */
  readOnly?: boolean;
}

// spec-247 dec-3 (ac-11): the panel header. "Spec assistant" names the job;
// the "private chat" qualifier keeps the old name's privacy connotation.
function AssistantHeading() {
  return (
    <h3 className="text-sm font-medium text-secondary">
      Spec assistant{' '}
      <span className="text-xs font-normal text-muted">· private chat</span>
    </h3>
  );
}

// spec-247 dec-3 (ac-12): the permanent grounding line — visible without any
// interaction, under the header. Discloses GROUNDING, not capability (the web
// agent shares the MCP tool catalog per spec-14 dec-4): it works on this spec
// and has not read the user's code; code-grounded answers come from a
// connected coding agent (the spec-201 setup surface).
function GroundingLine() {
  return (
    <div
      data-testid="chat-grounding-line"
      className="flex-none px-4 py-1.5 border-b border-edge text-[11px] leading-snug text-muted"
    >
      Works on this spec. Hasn't read your code.{' '}
      <Link
        to="/settings/integrations"
        className="underline underline-offset-2 hover:text-primary"
      >
        Connect a coding agent
      </Link>{' '}
      over MCP for code-grounded answers.
    </div>
  );
}

// spec-247 dec-3 (ac-13): detect code-shaped claims in assistant output so the
// grounding disclosure can sit ADJACENT to exactly the messages that make
// them. Deliberately conservative: fenced code blocks, file-extension paths,
// or talk of implementation ACs — the moments a reader might take a code claim
// on authority.
export function makesCodeShapedClaims(content: string): boolean {
  if (/```/.test(content)) return true;
  // A path-like token ending in a code-file extension (src/foo/bar.ts, a.py).
  if (/\b[\w.-]+(?:\/[\w.-]+)+\.[a-z]{1,8}\b/i.test(content)) return true;
  if (/\b[\w-]+\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb|java|rs|c|cpp|cs|php|swift|kt|sql|sh|yml|yaml|toml)\b/.test(content)) return true;
  if (/implementation ac/i.test(content)) return true;
  return false;
}

export function ChatPanel({ isAuthenticated = true, readOnly = false }: ChatPanelProps = {}) {
  const { messages, isStreaming, error, sendMessage, stopStreaming, clearChat, respondedToolIds, respondToUiTool, docId, doc, contextChips, isDriftMode } = useChat();
  // spec-283 dec-1: the review buttons are POSTURE-INDEPENDENT — gated solely on
  // the Spec's phase (`doc.status==='specify'`, already exposed by useChat) and
  // an idle conversation (`messages.length===0`). No `canEdit`/posture is
  // threaded in; ChatContext stays untouched.
  const orgBlocks = useOrgScaffoldBlocks();
  const showReviewActions = doc?.status === 'specify' && messages.length === 0;

  const sendReviewPrompt = (buttonId: string) => {
    // The four review prompts carry no `{placeholder}` tokens, so an empty
    // context resolves them fully; orgBlocks splice in any Org appends.
    const prompt = toButtonPrompt({ dataset: BASE_SCAFFOLD, buttonId, context: {}, orgBlocks });
    if (prompt === null) {
      const message = `ChatPanel: no PromptButtonNode found for buttonId="${buttonId}"`;
      if (import.meta.env.DEV) throw new Error(message);
      // eslint-disable-next-line no-console
      console.error(message);
      return;
    }
    sendMessage(prompt);
  };
  // spec-143 t-4 (dec-6): in drift mode the agent is LIVE on arrival (the Drift
  // Inbox has no bound doc), so the input is enabled before any context chip.
  const canChat = !!docId || contextChips.length > 0 || isDriftMode;
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScroll = useRef(true);

  useEffect(() => {
    if (shouldAutoScroll.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    shouldAutoScroll.current = atBottom;
  };

  // When the user responds to an in-chat UI tool, the new turn appears at the
  // BOTTOM (below the affordance they just acted on). Re-pin auto-scroll and snap
  // down so it's visibly clear the agent received the instruction — acting on a
  // UI tool shouldn't leave the response off-screen.
  const snapToBottom = () => {
    shouldAutoScroll.current = true;
    // rAF: let the click's state update flush so we scroll past the new content.
    requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    });
  };
  const handleUiToolRespond = (toolId: string, result: string) => {
    snapToBottom();
    respondToUiTool(toolId, result);
  };

  const handleSend = () => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput('');
    sendMessage(text);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // spec-111 t-9 / dec-2: anonymous visitors don't get agent access — show a
  // "Sign in to chat" placeholder where the chat UI would be. This is the
  // conversion funnel: visible-but-gated agent next to readable content.
  if (!isAuthenticated) {
    return (
      <div className="flex flex-col h-full bg-surface" data-testid="chat-signin-placeholder">
        <div className="flex-none px-4 py-3 border-b border-edge flex items-center justify-between">
          <AssistantHeading />
        </div>
        <GroundingLine />
        <div className="flex-1 flex flex-col items-center justify-center px-6 text-center gap-3">
          <p className="text-sm font-medium text-primary">Sign in to chat</p>
          <p className="text-sm text-muted">
            Log in or sign up to ask the agent questions about this Memex.
          </p>
          {/* Same Log in / Sign up pair as the sidebar (PublicAuthButtons). */}
          <div className="w-full max-w-[220px]">
            <PublicAuthButtons />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-surface">
      {/* Header */}
      <div className="flex-none px-4 py-3 border-b border-edge flex items-center justify-between">
        <AssistantHeading />
        {messages.length > 0 && (
          <button
            onClick={clearChat}
            className="text-xs text-muted hover:text-primary transition-colors"
          >
            Clear
          </button>
        )}
      </div>
      <GroundingLine />

      {/* Messages */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-4 py-4 space-y-4"
      >
        {readOnly && (
          <div
            data-testid="chat-readonly-banner"
            className="px-3 py-2 rounded-lg bg-surface/50 border border-edge-subtle text-xs text-muted"
          >
            Read-only — the agent can answer questions and search, but can't
            make changes.
          </div>
        )}

        {/* spec-159: opening a Spec no longer auto-activates the agent. The
            page itself carries phase, readiness, the Rubicon line, and handoff
            prompts — so the chat sits idle until the user types or clicks a
            prompt.
            spec-283: in the Specify phase the idle state also offers the four
            review actions (dec-1…dec-4). They render for EVERY viewer — editor,
            reviewer, and read-only non-member alike (dec-3) — with no
            posture-specific copy (dec-2). Clicking one injects that review
            prompt straight into the chat; the block disappears the moment a
            conversation starts (messages.length > 0). */}
        {messages.length === 0 && showReviewActions && (
          <div
            data-testid="agent-review-actions"
            className="flex flex-col items-center gap-3 py-8"
          >
            <p className="text-sm text-muted text-center">
              Ask a question, or start with a review:
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              {REVIEW_ACTIONS.map((action) => (
                <Button
                  key={action.buttonId}
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => sendReviewPrompt(action.buttonId)}
                >
                  {action.label}
                </Button>
              ))}
            </div>
          </div>
        )}
        {messages.length === 0 && !showReviewActions && (
          <div className="text-sm text-muted text-center py-8">
            {canChat ? 'Ask a question about this Spec...' : 'Open a Spec to start chatting'}
          </div>
        )}

        {messages.map((msg) => {
          if (msg.role === 'user') {
            return (
              <div key={msg.id} className="flex justify-end">
                <div className="max-w-[85%] px-3 py-2 rounded-lg text-sm bg-surface/50 border border-edge-subtle text-primary">
                  {msg.content}
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
                {/* spec-247 dec-3 (ac-13): when the answer makes code-shaped
                    claims, the grounding disclosure sits next to THAT output,
                    not only in the header. */}
                {makesCodeShapedClaims(msg.content) && (
                  <p
                    data-testid="code-claim-disclosure"
                    className="mt-1 text-[11px] italic text-muted"
                  >
                    Doc-grounded answer — this assistant hasn't read your code.
                    Verify code specifics with your coding agent.
                  </p>
                )}
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
                disabled={respondedToolIds.has(msg.toolId)}
                onRespond={handleUiToolRespond}
              />
            );
          }

          return null;
        })}

        {isStreaming && (
          <div className="flex items-center gap-1.5 text-xs text-muted">
            <span className="opening-status-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span role="status">Thinking…</span>
          </div>
        )}

        {error && (
          <div className="px-3 py-2 rounded-lg bg-status-danger-bg border border-status-danger-border text-sm text-status-danger-text">
            {error}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Context chips */}
      <ContextChipBar />

      {/* Input */}
      <div className="flex-none p-3 border-t border-edge">
        <div className="relative">
          <TextArea
            id="chat-input"
            data-testid="chat-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={!canChat}
            placeholder={canChat ? 'Ask me anything...' : 'Open a Spec first'}
            rows={3}
            className="pb-11"
          />
          <div className="absolute bottom-2 right-2 flex items-center gap-1.5">
            {isStreaming && (
              <button
                onClick={stopStreaming}
                className="p-1.5 rounded-md border transition-colors border-edge text-secondary hover:border-status-danger-border hover:text-status-danger-text"
                title="Stop generating"
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="3.5" y="3.5" width="9" height="9" rx="1" />
                </svg>
              </button>
            )}
            <Button
              onClick={handleSend}
              disabled={!input.trim() || isStreaming || !canChat}
            >
              Send
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
