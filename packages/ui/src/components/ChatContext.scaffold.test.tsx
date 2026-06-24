// spec-360 issue-2 / issue-6 — the ChatContext scaffold-mode machinery.
//
// issue-2: startScaffoldOpeningTurn no-ops outside scaffold mode, fires exactly
//   once per scaffold-mode entry, and enterScaffoldMode resets the guard so a
//   fresh entry fires again.
// issue-6: an assistant turn carrying a `render_scaffold_navigate` tool_use sets
//   scaffoldNav (target + bumped seq) and renders NO chat widget; a repeat to the
//   same target bumps seq; enter/exitScaffoldMode clears scaffoldNav.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { SCAFFOLD_OPENING_TURN_SEED } from '@memex/shared';
import type { AgentCallbacks } from '../agent/graph';

// ── mocks ───────────────────────────────────────────────────────────────────

vi.mock('./AuthContext', () => ({
  useAuth: () => ({ token: 'test-token' }),
}));

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

// invoke is the agent entrypoint ChatContext drives. We capture each call's
// args (so we can assert agentMode / seed) AND optionally fire the supplied
// callbacks to simulate an assistant turn (so we can drive scaffoldNav).
const invokeArgs: Array<{
  userMessage?: string;
  agentMode?: string;
  callbacks?: AgentCallbacks;
}> = [];
let onInvoke: ((args: { callbacks?: AgentCallbacks }) => void) | null = null;

const mockInvoke = vi.fn(async (args: { userMessage?: string; agentMode?: string; callbacks?: AgentCallbacks }) => {
  invokeArgs.push({ userMessage: args.userMessage, agentMode: args.agentMode, callbacks: args.callbacks });
  onInvoke?.(args);
  return { messages: [], docId: null };
});
const mockResume = vi.fn(async () => ({ messages: [], docId: null }));

vi.mock('../agent/useAgentGraph', () => ({
  useAgentGraph: () => ({ invoke: mockInvoke, resume: mockResume }),
}));

import { ChatProvider, useChat } from './ChatContext';

// ── test harness: exposes the context methods + state to the test ────────────

let ctx: ReturnType<typeof useChat>;
function Capture() {
  ctx = useChat();
  return (
    <div>
      <span data-testid="nav-seq">{ctx.scaffoldNav ? ctx.scaffoldNav.seq : 'null'}</span>
      <span data-testid="nav-target">{JSON.stringify(ctx.scaffoldNav?.target ?? null)}</span>
      <span data-testid="msg-count">{ctx.messages.length}</span>
      <span data-testid="ui-tools">
        {ctx.messages.filter((m) => m.role === 'ui_tool').map((m) => m.toolName).join(',')}
      </span>
    </div>
  );
}

function renderProvider() {
  return render(
    <ChatProvider>
      <Capture />
    </ChatProvider>,
  );
}

const AC2 = 'mindset-prod/memex-building-itself/specs/spec-360/acs/ac-6';
const AC6 = 'mindset-prod/memex-building-itself/specs/spec-360/acs/ac-9';

beforeEach(() => {
  vi.clearAllMocks();
  invokeArgs.length = 0;
  onInvoke = null;
});

describe('ChatContext.startScaffoldOpeningTurn (issue-2, ac-6)', () => {
  it('no-ops outside scaffold mode', async () => {
    tagAc(AC2);
    renderProvider();
    await act(async () => {
      ctx.startScaffoldOpeningTurn(SCAFFOLD_OPENING_TURN_SEED);
    });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('fires exactly once per scaffold-mode entry; re-invocation is a no-op', async () => {
    tagAc(AC2);
    renderProvider();
    await act(async () => {
      ctx.enterScaffoldMode();
    });
    await act(async () => {
      ctx.startScaffoldOpeningTurn(SCAFFOLD_OPENING_TURN_SEED);
    });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    // The seed rides as the user message, on the scaffold surface.
    expect(invokeArgs[0].userMessage).toBe(SCAFFOLD_OPENING_TURN_SEED);
    expect(invokeArgs[0].agentMode).toBe('scaffold');

    // A second invocation in the SAME entry does nothing (guarded once-per-entry).
    await act(async () => {
      ctx.startScaffoldOpeningTurn(SCAFFOLD_OPENING_TURN_SEED);
    });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it('enterScaffoldMode resets the guard so a fresh entry fires again', async () => {
    tagAc(AC2);
    renderProvider();
    await act(async () => { ctx.enterScaffoldMode(); });
    await act(async () => { ctx.startScaffoldOpeningTurn(SCAFFOLD_OPENING_TURN_SEED); });
    expect(mockInvoke).toHaveBeenCalledTimes(1);

    // Leave and re-enter — the once-per-entry guard resets.
    await act(async () => { ctx.exitScaffoldMode(); });
    await act(async () => { ctx.enterScaffoldMode(); });
    await act(async () => { ctx.startScaffoldOpeningTurn(SCAFFOLD_OPENING_TURN_SEED); });
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });
});

describe('ChatContext scaffoldNav from render_scaffold_navigate (issue-6, ac-9)', () => {
  // Drive an assistant turn whose content carries a render_scaffold_navigate
  // tool_use block — invoke fires the supplied callbacks.onAssistantTurnComplete.
  function navigateTo(target: Record<string, unknown>) {
    onInvoke = (args) => {
      args.callbacks?.onAssistantTurnComplete?.([
        { type: 'tool_use', id: `tu-${Math.random()}`, name: 'render_scaffold_navigate', input: target },
      ] as never);
    };
  }

  it('sets scaffoldNav (target + seq 1) and renders NO chat widget', async () => {
    tagAc(AC6);
    renderProvider();
    await act(async () => { ctx.enterScaffoldMode(); });
    navigateTo({ phase: 'build' });
    await act(async () => { ctx.sendMessage('where do build tasks go?'); });

    await waitFor(() => expect(screen.getByTestId('nav-seq').textContent).toBe('1'));
    expect(JSON.parse(screen.getByTestId('nav-target').textContent!)).toEqual({ phase: 'build' });
    // The navigate tool renders no ui_tool message — it is a pure side-effect.
    expect(screen.getByTestId('ui-tools').textContent).toBe('');
  });

  it('a second nav to the SAME target bumps seq', async () => {
    tagAc(AC6);
    renderProvider();
    await act(async () => { ctx.enterScaffoldMode(); });

    navigateTo({ phase: 'build' });
    await act(async () => { ctx.sendMessage('show build'); });
    await waitFor(() => expect(screen.getByTestId('nav-seq').textContent).toBe('1'));

    navigateTo({ phase: 'build' });
    await act(async () => { ctx.sendMessage('show build again'); });
    await waitFor(() => expect(screen.getByTestId('nav-seq').textContent).toBe('2'));
    // Same target, higher seq → the surface effect re-fires.
    expect(JSON.parse(screen.getByTestId('nav-target').textContent!)).toEqual({ phase: 'build' });
  });

  it('exitScaffoldMode clears scaffoldNav', async () => {
    tagAc(AC6);
    renderProvider();
    await act(async () => { ctx.enterScaffoldMode(); });
    navigateTo({ tool: 'create_task', phase: 'build' });
    await act(async () => { ctx.sendMessage('show create_task'); });
    await waitFor(() => expect(screen.getByTestId('nav-seq').textContent).toBe('1'));

    await act(async () => { ctx.exitScaffoldMode(); });
    expect(screen.getByTestId('nav-seq').textContent).toBe('null');
  });

  it('re-entering scaffold mode clears scaffoldNav', async () => {
    tagAc(AC6);
    renderProvider();
    await act(async () => { ctx.enterScaffoldMode(); });
    navigateTo({ phase: 'verify' });
    await act(async () => { ctx.sendMessage('show verify'); });
    await waitFor(() => expect(screen.getByTestId('nav-seq').textContent).toBe('1'));

    await act(async () => { ctx.exitScaffoldMode(); });
    await act(async () => { ctx.enterScaffoldMode(); });
    expect(screen.getByTestId('nav-seq').textContent).toBe('null');
  });
});
