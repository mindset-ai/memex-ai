import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { tagAc } from '@memex-ai-ac/vitest';

const SPEC = 'mindset-prod/memex-building-itself/specs/spec-123';

// ── Mocks ──

const mockInvoke = vi.fn();
const mockResume = vi.fn();

vi.mock('../agent/useAgentGraph', () => ({
  useAgentGraph: () => ({ invoke: mockInvoke, resume: mockResume }),
}));

vi.mock('./AuthContext', () => ({
  useAuth: () => ({ token: 'test-token' }),
}));

vi.mock('../agent/llm-client', () => ({
  setLlmAuthToken: vi.fn(),
}));

vi.mock('../agent/tool-client', () => ({
  setToolAuthToken: vi.fn(),
  executeToolRemote: vi.fn(),
}));

vi.mock('../agent/conversation-client', () => ({
  setConversationAuthToken: vi.fn(),
  saveConversation: vi.fn().mockResolvedValue(undefined),
  loadConversation: vi.fn().mockResolvedValue([]),
  clearConversationRemote: vi.fn().mockResolvedValue(undefined),
}));

import { ChatProvider, useChat } from './ChatContext';
import { loadConversation, clearConversationRemote } from '../agent/conversation-client';

function wrapper({ children }: { children: ReactNode }) {
  return <ChatProvider>{children}</ChatProvider>;
}

describe('ChatContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadConversation).mockResolvedValue([]);
  });

  it('sendMessage adds user message, invokes graph, and appends assistant response', async () => {
    mockInvoke.mockImplementationOnce(async ({ callbacks }: { callbacks: { onTextDelta?: (t: string) => void } }) => {
      // Simulate streaming: a text delta creates the assistant placeholder and
      // fills it. Real graph runs always stream text via onTextDelta.
      callbacks.onTextDelta?.('Hi!');
      return {
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: [{ type: 'text', text: 'Hi!' }] },
        ],
        docId: null,
      };
    });

    const { result } = renderHook(() => useChat(), { wrapper });

    // Set a docId so sendMessage works with a context
    act(() => { result.current.setDocId('doc-1'); });

    await act(async () => {
      result.current.sendMessage('hello');
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(false);
    });

    // Should have user + assistant messages
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[0].role).toBe('user');
    expect(result.current.messages[0].content).toBe('hello');
    expect(result.current.messages[1].role).toBe('assistant');
    expect(result.current.messages[1].content).toBe('Hi!');
  });

  it('streaming text deltas update assistant message content progressively', async () => {
    // Capture the callbacks when invoke is called, then simulate streaming
    mockInvoke.mockImplementationOnce(async ({ callbacks }: { callbacks: { onTextDelta?: (t: string) => void } }) => {
      callbacks.onTextDelta?.('Hello');
      callbacks.onTextDelta?.(' world');
      return {
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] },
        ],
        docId: null,
      };
    });

    const { result } = renderHook(() => useChat(), { wrapper });
    act(() => { result.current.setDocId('doc-1'); });

    await act(async () => {
      result.current.sendMessage('hi');
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(false);
    });

    const assistantMsg = result.current.messages.find((m) => m.role === 'assistant');
    expect(assistantMsg?.content).toContain('Hello');
    expect(assistantMsg?.content).toContain(' world');
  });

  it('server tool execution updates tool_status messages via callbacks', async () => {
    mockInvoke.mockImplementationOnce(async ({ callbacks }: { callbacks: { onToolStart?: (n: string, id: string) => void; onToolResult?: (id: string, r: string) => void } }) => {
      callbacks.onToolStart?.('update_section', 'tool-1');
      callbacks.onToolResult?.('tool-1', 'Section updated');
      return {
        messages: [
          { role: 'user', content: 'update' },
          { role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
        ],
        docId: null,
      };
    });

    const { result } = renderHook(() => useChat(), { wrapper });
    act(() => { result.current.setDocId('doc-1'); });

    await act(async () => {
      result.current.sendMessage('update');
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(false);
    });

    const toolMsg = result.current.messages.find((m) => m.role === 'tool_status');
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.content).toBe('Section updated');
  });

  it('UI tool turn adds a ui_tool message in the correct position', async () => {
    mockInvoke.mockImplementationOnce(async ({ callbacks }: { callbacks: { onAssistantTurnComplete?: (content: unknown[]) => void } }) => {
      callbacks.onAssistantTurnComplete?.([
        { type: 'tool_use', id: 'ui-1', name: 'render_confirmation', input: { message: 'Sure?' } },
      ]);
      return {
        messages: [
          { role: 'user', content: 'delete' },
          { role: 'assistant', content: [
            { type: 'tool_use', id: 'ui-1', name: 'render_confirmation', input: { message: 'Sure?' } },
          ] },
        ],
        docId: null,
      };
    });

    const { result } = renderHook(() => useChat(), { wrapper });
    act(() => { result.current.setDocId('doc-1'); });

    await act(async () => {
      result.current.sendMessage('delete');
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(false);
    });

    const uiMsg = result.current.messages.find((m) => m.role === 'ui_tool');
    expect(uiMsg).toBeDefined();
    expect(uiMsg?.toolName).toBe('render_confirmation');
    expect(uiMsg?.toolInput).toEqual({ message: 'Sure?' });
  });

  it('respondToUiTool is idempotent — ignores duplicate toolId', async () => {
    // First, set up a conversation with a UI tool pending
    mockInvoke.mockResolvedValueOnce({
      messages: [
        { role: 'user', content: 'do it' },
        { role: 'assistant', content: [
          { type: 'tool_use', id: 'ui-1', name: 'render_confirmation', input: {} },
        ] },
      ],
      docId: null,
    });

    mockResume.mockResolvedValue({
      messages: [
        { role: 'user', content: 'do it' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'ui-1', name: 'render_confirmation', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ui-1', content: 'yes' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
      ],
      docId: null,
    });

    const { result } = renderHook(() => useChat(), { wrapper });
    act(() => { result.current.setDocId('doc-1'); });

    await act(async () => {
      result.current.sendMessage('do it');
    });

    await waitFor(() => expect(result.current.isStreaming).toBe(false));

    // First respond — should call resume
    await act(async () => {
      result.current.respondToUiTool('ui-1', 'yes');
    });
    await waitFor(() => expect(result.current.isStreaming).toBe(false));

    expect(mockResume).toHaveBeenCalledTimes(1);

    // Second respond with same toolId — should be ignored
    await act(async () => {
      result.current.respondToUiTool('ui-1', 'yes');
    });

    expect(mockResume).toHaveBeenCalledTimes(1); // still 1
  });

  // spec-123 t-3 — opening a Spec is a fresh agent-led walkthrough. The thread
  // is HARD-RESET on open (ac-3): the prior stored conversation is NOT restored,
  // and the remote store is cleared so a reopen stays clean (ac-7). This
  // replaces the old "restore saved conversation on open" behaviour.
  it('open hard-resets the thread — no prior conversation is restored (ac-3, ac-8)', async () => {
    tagAc(`${SPEC}/acs/ac-3`);
    tagAc(`${SPEC}/acs/ac-8`);

    // Even if a stored conversation exists, opening the Spec must not surface it.
    vi.mocked(loadConversation).mockResolvedValue([
      { role: 'user' as const, content: 'old question' },
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'old answer' }] },
    ]);

    const { result } = renderHook(() => useChat(), { wrapper });

    act(() => { result.current.setDocId('doc-restored'); });

    // Give any (now-removed) restore effect a chance to run — the thread must
    // stay empty. spec-159: opening a Spec no longer auto-activates the agent, so
    // the chat is empty until the user acts.
    await waitFor(() => expect(clearConversationRemote).toHaveBeenCalledWith('doc-restored'));
    expect(result.current.messages).toEqual([]);
    expect(loadConversation).not.toHaveBeenCalled();
  });

  it('open calls the clear path so the conversation is clean (ac-7)', async () => {
    tagAc(`${SPEC}/acs/ac-7`);

    const { result } = renderHook(() => useChat(), { wrapper });
    act(() => { result.current.setDocId('doc-open'); });

    await waitFor(() => expect(clearConversationRemote).toHaveBeenCalledWith('doc-open'));
    expect(result.current.messages).toEqual([]);
  });

  // spec-159: opening a Spec no longer auto-activates the agent. The page itself
  // carries phase, readiness, the Rubicon line, handoff prompts, and the reviewer
  // block, so the chat sits idle on open — the agent is invoked only when the user
  // types or clicks a prompt.
  it('opening a Spec does NOT invoke the agent — a turn starts only on user action (spec-159 ac-20)', async () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-159/acs/ac-20');
    mockInvoke.mockImplementation(async () => ({
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: [{ type: 'text', text: 'yo' }] }],
      docId: null,
    }));

    const { result } = renderHook(() => useChat(), { wrapper });
    act(() => { result.current.setDocId('doc-user-turn'); });

    // Opening the doc clears the thread but does NOT invoke the agent by itself —
    // only a user action does.
    await waitFor(() => expect(clearConversationRemote).toHaveBeenCalledWith('doc-user-turn'));
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(result.current.messages).toEqual([]);

    await act(async () => { result.current.sendMessage('hi'); });
    await waitFor(() => expect(result.current.isStreaming).toBe(false));

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(result.current.messages.some((m) => m.role === 'user' && m.content === 'hi')).toBe(true);
  });

  // spec-157 t-1 (dec-1): tool results are agent-facing prompts — outcome
  // sentence first, nudges after the first blank line (tool-specs.ts
  // convention). The doc chat shows only the leading chunk for successes;
  // errors stay verbatim (the contract spec-155 i-1 pinned for NewSpecModal).
  describe('tool-result display filter (spec-157)', () => {
    const SPEC_157 = 'mindset-prod/memex-building-itself/specs/spec-157';

    // Runs one agent turn that fires onToolStart + onToolResult with the
    // given result string, then returns the resulting tool_status message.
    async function runToolTurn(result: string) {
      mockInvoke.mockImplementationOnce(async ({ callbacks }: { callbacks: { onToolStart?: (n: string, id: string) => void; onToolResult?: (id: string, r: string) => void } }) => {
        callbacks.onToolStart?.('some_tool', 'tool-157');
        callbacks.onToolResult?.('tool-157', result);
        return {
          messages: [
            { role: 'user', content: 'go' },
            { role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
          ],
          docId: null,
        };
      });

      const rendered = renderHook(() => useChat(), { wrapper });
      act(() => { rendered.result.current.setDocId('doc-157'); });
      await act(async () => { rendered.result.current.sendMessage('go'); });
      await waitFor(() => expect(rendered.result.current.isStreaming).toBe(false));
      return rendered.result.current.messages.find((m) => m.role === 'tool_status');
    }

    it("create_doc's Scope-AC nudge is hidden — only the outcome line shows (ac-1, ac-4)", async () => {
      tagAc(`${SPEC_157}/acs/ac-1`);
      tagAc(`${SPEC_157}/acs/ac-4`);

      // Real create_doc result shape: ref line, then the agent-facing nudge
      // after the first blank line (tool-specs.ts).
      const toolMsg = await runToolTurn(
        'ref: mindset-prod/memex-building-itself/specs/spec-200 "New Spec"\n\n' +
          'Next: author Scope ACs for this Spec. Scope ACs are plain-English outcome commitments — ' +
          'Walk the user through 3–5 of them now via:\n' +
          '  create_ac({ ref: "mindset-prod/memex-building-itself/specs/spec-200", kind: "scope", statement: "..." })\n' +
          "Don't skip this in draft/plan. See get_information(topic='phases') for the full phase mechanics."
      );

      expect(toolMsg?.content).toBe(
        'ref: mindset-prod/memex-building-itself/specs/spec-200 "New Spec"'
      );
      expect(toolMsg?.content).not.toContain('create_ac');
      expect(toolMsg?.content).not.toContain('get_information');
    });

    it("resolve_decision's sketch + Issues nudges are hidden; the outcome sentence (with hint) shows (ac-1, ac-4)", async () => {
      tagAc(`${SPEC_157}/acs/ac-1`);
      tagAc(`${SPEC_157}/acs/ac-4`);

      // Real resolve_decision shape (post spec-157 t-2: the sketch block leads
      // with a blank line per the tool-specs.ts convention). The hint rides the
      // outcome line itself and stays visible.
      const outcome =
        'Decision resolved: ref: mindset-prod/memex-building-itself/specs/spec-200/decisions/dec-1 ' +
        '"Which cache?" — Use Redis. This was the last open decision; Spec can move to build.';
      const toolMsg = await runToolTurn(
        outcome +
          "\n\nThis decision's implementation ACs are pending verification. For each:\n\n" +
          '  ac-2 (Cache reads hit Redis)\n' +
          '    suggested test shape: behavioural test against the named endpoint\n' +
          "    tagAc('mindset-prod/memex-building-itself/specs/spec-200/acs/ac-2')\n\n" +
          'Related Issues (informational — may inform this decision; nothing was changed):\n' +
          '  - mindset-prod/memex-building-itself/specs/spec-200/issues/issue-9 — "Cache misses" (bug, open)'
      );

      expect(toolMsg?.content).toBe(outcome);
      expect(toolMsg?.content).not.toContain('tagAc');
      expect(toolMsg?.content).not.toContain('Related Issues');
    });

    it('single-line outcome sentences show whole — feedback never collapses to a marker (ac-3)', async () => {
      tagAc(`${SPEC_157}/acs/ac-3`);

      const toolMsg = await runToolTurn(
        'Section updated (ref: mindset-prod/memex-building-itself/specs/spec-200/sections/s-1).'
      );

      // The full outcome sentence — which section was touched — not "Ran <tool>".
      expect(toolMsg?.content).toBe(
        'Section updated (ref: mindset-prod/memex-building-itself/specs/spec-200/sections/s-1).'
      );
    });

    it('errors stay fully verbatim, blank lines included (ac-2)', async () => {
      tagAc(`${SPEC_157}/acs/ac-2`);

      // graph.ts prefixes every failure with "Error: " — keep the whole thing,
      // even when the message itself contains a blank line.
      const error =
        'Error: update_section failed: section not found.\n\n' +
        'The ref may be stale — re-fetch the doc and retry with the current section ref.';
      const toolMsg = await runToolTurn(error);

      expect(toolMsg?.content).toBe(error);
    });
  });

  it('clearChat aborts streaming and clears remote conversation', async () => {
    const { result } = renderHook(() => useChat(), { wrapper });

    act(() => { result.current.setDocId('doc-clear'); });

    act(() => {
      result.current.clearChat();
    });

    expect(result.current.messages).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(clearConversationRemote).toHaveBeenCalledWith('doc-clear');
  });

  it('error during invoke sets error state', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('Network failure'));

    const { result } = renderHook(() => useChat(), { wrapper });
    act(() => { result.current.setDocId('doc-1'); });

    await act(async () => {
      result.current.sendMessage('fail');
    });

    await waitFor(() => expect(result.current.isStreaming).toBe(false));
    expect(result.current.error).toBe('Network failure');
  });

  it('AbortError during invoke does not set error state', async () => {
    const abortError = new DOMException('Aborted', 'AbortError');
    mockInvoke.mockRejectedValueOnce(abortError);

    const { result } = renderHook(() => useChat(), { wrapper });
    act(() => { result.current.setDocId('doc-1'); });

    await act(async () => {
      result.current.sendMessage('cancel');
    });

    await waitFor(() => expect(result.current.isStreaming).toBe(false));
    expect(result.current.error).toBeNull();
  });
});
