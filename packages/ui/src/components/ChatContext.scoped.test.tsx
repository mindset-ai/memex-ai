// spec-389 (dec-1/dec-2) — the ChatContext standards / issues mode machinery:
//   - enterStandardsMode / enterIssuesMode flip the mode (isStandardsMode /
//     isIssuesMode) and unbind any doc; exitScopedMode resets to 'spec'.
// Per dec-1 the scoped agents open with a STATIC intro card, not an opening LLM
// turn (unlike drift), so there is no startScopedOpeningTurn to exercise here.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import type { AgentCallbacks } from '../agent/graph';

vi.mock('./AuthContext', () => ({ useAuth: () => ({ token: 'test-token' }) }));
vi.mock('../agent/llm-client', () => ({ setLlmAuthToken: vi.fn() }));
vi.mock('../agent/tool-client', () => ({
  setToolAuthToken: vi.fn(),
  executeToolRemote: vi.fn(),
}));
vi.mock('../agent/conversation-client', () => ({
  setConversationAuthToken: vi.fn(),
  saveConversation: vi.fn(),
  clearConversationRemote: vi.fn().mockResolvedValue(undefined),
}));

const invokeArgs: Array<{ userMessage?: string; agentMode?: string }> = [];
const mockInvoke = vi.fn(
  async (args: { userMessage?: string; agentMode?: string; callbacks?: AgentCallbacks }) => {
    invokeArgs.push({ userMessage: args.userMessage, agentMode: args.agentMode });
    return { messages: [], docId: null };
  },
);
const mockResume = vi.fn(async () => ({ messages: [], docId: null }));
vi.mock('../agent/useAgentGraph', () => ({
  useAgentGraph: () => ({ invoke: mockInvoke, resume: mockResume }),
}));

import { ChatProvider, useChat } from './ChatContext';

let ctx: ReturnType<typeof useChat>;
function Capture() {
  ctx = useChat();
  return null;
}
function renderProvider() {
  return render(
    <ChatProvider>
      <Capture />
    </ChatProvider>,
  );
}

const AC_NEW_AGENTS =
  'mindset-prod/memex-building-itself/specs/spec-389/acs/ac-4';

beforeEach(() => {
  vi.clearAllMocks();
  invokeArgs.length = 0;
});

describe('ChatContext — standards / issues mode entry (ac-4)', () => {
  it('enterStandardsMode flips into standards mode; exitScopedMode resets to spec', async () => {
    tagAc(AC_NEW_AGENTS);
    renderProvider();
    expect(ctx.isStandardsMode).toBe(false);
    await act(async () => { ctx.enterStandardsMode(); });
    expect(ctx.isStandardsMode).toBe(true);
    expect(ctx.isIssuesMode).toBe(false);
    await act(async () => { ctx.exitScopedMode(); });
    expect(ctx.isStandardsMode).toBe(false);
  });

  it('enterIssuesMode flips into issues mode', async () => {
    tagAc(AC_NEW_AGENTS);
    renderProvider();
    await act(async () => { ctx.enterIssuesMode(); });
    expect(ctx.isIssuesMode).toBe(true);
    expect(ctx.isStandardsMode).toBe(false);
  });

  it('the scoped agents do NOT fire an opening LLM turn on entry (dec-1: static intro)', async () => {
    tagAc(AC_NEW_AGENTS);
    renderProvider();
    await act(async () => { ctx.enterStandardsMode(); });
    await act(async () => { ctx.enterIssuesMode(); });
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
