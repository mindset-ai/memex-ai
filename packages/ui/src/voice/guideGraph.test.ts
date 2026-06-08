// t-3 guide graph — topology + screens-as-state (dec-1 / ac-11). The guide LLM
// proxy is mocked (a fake SSE stream), so this exercises the graph wiring without
// the server. Proves: one conversational node serves every screen (screen context
// comes from STATE, refreshed before the next turn), the agent→tools→agent loop,
// and that search_guide goes through the injected server-tool executor.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';

vi.mock('./guideLlmClient', () => ({
  callGuideLlmProxy: vi.fn(),
  setGuideAuthToken: vi.fn(),
}));

import { createGuideGraph, GUIDE_CLIENT_TOOLS } from './guideGraph';
import { callGuideLlmProxy, type GuideLlmInput } from './guideLlmClient';
import type { ContentBlock } from '../agent/types';

const AC11 = 'mindset-prod/memex-building-itself/specs/spec-190/acs/ac-11';
// Scope ac-4: the guide's context follows navigation — screens are STATE, refreshed
// before the next turn, so it answers about the screen the user is actually on.
const AC4 = 'mindset-prod/memex-building-itself/specs/spec-190/acs/ac-4';

async function* fakeStream(events: unknown[]) {
  for (const e of events) yield e as never;
}

describe('guide graph (ac-11)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('serves every screen through the SAME node — screen context comes from state, refreshed before the next turn', async () => {
    const seen: Array<string | null> = [];
    vi.mocked(callGuideLlmProxy).mockImplementation((input: GuideLlmInput) => {
      seen.push(input.screenKey);
      return fakeStream([
        { type: 'message_complete', content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
      ]);
    });

    const graph = createGuideGraph();
    await graph.invoke(
      {
        messages: [{ role: 'user', content: 'what is this?' }],
        screenKey: 'spec-detail',
        screenRegistry: [{ id: 'phase-pill', description: 'the phase pill' }],
        guideContext: ['spec detail help'],
      },
      { configurable: { thread_id: 't1' } },
    );
    // The user navigates mid-conversation; the next turn carries the NEW screen
    // state (same thread → state update, not a new graph).
    await graph.invoke(
      {
        messages: [{ role: 'user', content: 'and now?' }],
        screenKey: 'standards-list',
        screenRegistry: [{ id: 'standards-search', description: 'search standards' }],
        guideContext: ['standards help'],
      },
      { configurable: { thread_id: 't1' } },
    );

    expect(seen).toEqual(['spec-detail', 'standards-list']);
    tagAc(AC11);
    tagAc(AC4); // scope: context follows navigation (screens-as-state)
  });

  it('loops guideAgent → tools → guideAgent on a client UI tool, then ends', async () => {
    let n = 0;
    vi.mocked(callGuideLlmProxy).mockImplementation(() => {
      n++;
      if (n === 1) {
        return fakeStream([
          {
            type: 'message_complete',
            content: [{ type: 'tool_use', id: 'tu1', name: 'highlight', input: { id: 'phase-pill' } }],
            stopReason: 'tool_use',
          },
        ]);
      }
      return fakeStream([
        { type: 'message_complete', content: [{ type: 'text', text: 'that pill shows the phase' }], stopReason: 'end_turn' },
      ]);
    });

    const onUiTool = vi.fn();
    const graph = createGuideGraph();
    const result = await graph.invoke(
      { messages: [{ role: 'user', content: 'where is the phase?' }], screenKey: 'spec-detail', screenRegistry: [], guideContext: [] },
      { configurable: { thread_id: 't2', callbacks: { onUiTool } } },
    );

    expect(onUiTool).toHaveBeenCalledWith('highlight', 'tu1', { id: 'phase-pill' });
    expect(n).toBe(2); // looped back for a second turn after the tool
    const last = result.messages[result.messages.length - 1] as { role: string; content: ContentBlock[] };
    expect(last.role).toBe('assistant');
    tagAc(AC11);
  });

  it('runs search_guide through the injected server-tool executor (never a client tool)', async () => {
    let n = 0;
    vi.mocked(callGuideLlmProxy).mockImplementation(() => {
      n++;
      if (n === 1) {
        return fakeStream([
          {
            type: 'message_complete',
            content: [{ type: 'tool_use', id: 'sg1', name: 'search_guide', input: { query: 'phases' } }],
            stopReason: 'tool_use',
          },
        ]);
      }
      return fakeStream([
        { type: 'message_complete', content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
      ]);
    });

    const executeServerTool = vi.fn(async () => 'phases: draft → specify → build → verify → done');
    const graph = createGuideGraph({ executeServerTool });
    await graph.invoke(
      { messages: [{ role: 'user', content: 'what are phases?' }], screenKey: 'specs-list', screenRegistry: [], guideContext: [] },
      { configurable: { thread_id: 't3' } },
    );

    expect(executeServerTool).toHaveBeenCalledWith('search_guide', { query: 'phases' }, undefined);
    tagAc(AC11);
  });

  it('classifies highlight/navigate/advance_demo as client tools and search_guide as a server tool', () => {
    expect(GUIDE_CLIENT_TOOLS.has('highlight')).toBe(true);
    expect(GUIDE_CLIENT_TOOLS.has('navigate')).toBe(true);
    // spec-206 t-4: the synced-walkthrough advance is React-executed (the graph
    // routes it to onUiTool → dispatchGuideUiTool → the shared reveal pointer).
    expect(GUIDE_CLIENT_TOOLS.has('advance_demo')).toBe(true);
    expect(GUIDE_CLIENT_TOOLS.has('search_guide')).toBe(false);
  });
});
