// spec-389 t-5 (dec-2) — the ChatContext standards / issues mode machinery,
// mirroring the drift / scaffold modes:
//   - enterStandardsMode / enterIssuesMode flip the mode (isStandardsMode /
//     isIssuesMode) and unbind any doc; exitScopedMode resets to 'spec';
//   - startScopedOpeningTurn no-ops outside its mode, fires exactly once per
//     entry on the right surface, and a fresh entry re-arms it.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import {
  STANDARDS_OPENING_TURN_SEED,
  ISSUES_OPENING_TURN_SEED,
} from '@memex/shared';
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
});

describe('ChatContext.startScopedOpeningTurn (ac-4)', () => {
  it('no-ops outside the matching mode', async () => {
    tagAc(AC_NEW_AGENTS);
    renderProvider();
    await act(async () => {
      ctx.startScopedOpeningTurn('standards', STANDARDS_OPENING_TURN_SEED);
    });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('fires once per standards entry on the standards surface; re-invocation no-ops', async () => {
    tagAc(AC_NEW_AGENTS);
    renderProvider();
    await act(async () => { ctx.enterStandardsMode(); });
    await act(async () => {
      ctx.startScopedOpeningTurn('standards', STANDARDS_OPENING_TURN_SEED);
    });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(invokeArgs[0].userMessage).toBe(STANDARDS_OPENING_TURN_SEED);
    expect(invokeArgs[0].agentMode).toBe('standards');
    await act(async () => {
      ctx.startScopedOpeningTurn('standards', STANDARDS_OPENING_TURN_SEED);
    });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it('a fresh entry re-arms the once-per-entry guard (issues)', async () => {
    tagAc(AC_NEW_AGENTS);
    renderProvider();
    await act(async () => { ctx.enterIssuesMode(); });
    await act(async () => {
      ctx.startScopedOpeningTurn('issues', ISSUES_OPENING_TURN_SEED);
    });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(invokeArgs[0].agentMode).toBe('issues');
    await act(async () => { ctx.exitScopedMode(); });
    await act(async () => { ctx.enterIssuesMode(); });
    await act(async () => {
      ctx.startScopedOpeningTurn('issues', ISSUES_OPENING_TURN_SEED);
    });
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });
});
