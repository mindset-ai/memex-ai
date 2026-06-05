import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import { useChat } from './ChatContext';
import { ChatMarkdown } from './chat/ChatMarkdown';
import { ContextChipBar } from './chat/ContextChipBar';
import { UiToolRenderer } from './chat/ui-tools';
import { TextArea } from './ui/TextArea';
import { Button } from './ui';
import { PublicAuthButtons } from './PublicAccessControls';

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

export function ChatPanel({ isAuthenticated = true, readOnly = false }: ChatPanelProps = {}) {
  const { messages, isStreaming, error, sendMessage, stopStreaming, clearChat, respondedToolIds, respondToUiTool, docId, contextChips, isDriftMode } = useChat();
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
          <h3 className="text-sm font-medium text-secondary">Private Agent</h3>
        </div>
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
        <h3 className="text-sm font-medium text-secondary">Private Agent</h3>
        {messages.length > 0 && (
          <button
            onClick={clearChat}
            className="text-xs text-muted hover:text-primary transition-colors"
          >
            Clear
          </button>
        )}
      </div>

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
            page itself carries phase, readiness, the Rubicon line, handoff
            prompts, and the reviewer block — so the chat sits idle until the
            user types or clicks a prompt. */}
        {messages.length === 0 && (
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
