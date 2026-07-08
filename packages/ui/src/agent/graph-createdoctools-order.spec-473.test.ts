import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the LLM and tool clients before importing graph — same pattern as
// graph.test.ts.
vi.mock('./llm-client', () => ({
  callLlmProxy: vi.fn(),
  callLlmCreateProxy: vi.fn(),
  setLlmAuthToken: vi.fn(),
}));

vi.mock('./tool-client', () => ({
  executeToolRemote: vi.fn(),
  setToolAuthToken: vi.fn(),
}));

import { createAgentGraph } from './graph';
import type { AgentCallbacks } from './graph';
import { callLlmCreateProxy } from './llm-client';
import { executeToolRemote } from './tool-client';
import type { ContentBlock, ToolResultBlock } from './types';

// Helper to create an async generator from an array of events.
async function* fakeStream(events: any[]) {
  for (const event of events) {
    yield event;
  }
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// ──────────────────────────────────────────────
// issue-6 — regression coverage for createDocToolsNode's ordering guarantee
// (spec-473's batched/parallel authoring turn).
//
// The node makes three promises:
//   1. `add_section` blocks run SERIALLY, in emit order (their write-time seq
//      becomes the section's display order, so they must not race);
//   2. every OTHER server tool block runs in PARALLEL (Promise.all);
//   3. the returned tool_result blocks are reassembled in the ORIGINAL emit
//      order (via a byId map), regardless of completion order.
//
// This is issue-6 regression coverage, not a spec-473 AC — no AC is tagged.
// ──────────────────────────────────────────────

describe('createDocToolsNode ordering guarantee (issue-6, spec-473)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it(
    'runs add_section serially in emit order, fans out the rest in parallel, and reassembles results in emit order',
    async () => {
      // A mixed authoring turn in a known emit order:
      //   add_section#A, create_decision#B, add_section#C, create_ac#D, add_section#E
      // Each block carries a unique `marker` in its input so the mocked executor
      // can identify it, and the block `id` == marker so we can match
      // tool_use_id → tool_result in the reassembled output.
      const authoringTurn: ContentBlock[] = [
        { type: 'tool_use', id: 'A', name: 'add_section', input: { marker: 'A', title: 'Sec A' } },
        { type: 'tool_use', id: 'B', name: 'create_decision', input: { marker: 'B' } },
        { type: 'tool_use', id: 'C', name: 'add_section', input: { marker: 'C', title: 'Sec C' } },
        { type: 'tool_use', id: 'D', name: 'create_ac', input: { marker: 'D' } },
        { type: 'tool_use', id: 'E', name: 'add_section', input: { marker: 'E', title: 'Sec E' } },
      ];
      const EMIT_ORDER = ['A', 'B', 'C', 'D', 'E'];
      const SECTION_MARKERS = ['A', 'C', 'E'];

      const followUp: ContentBlock[] = [{ type: 'text', text: 'Sections authored.' }];

      // First create-proxy turn emits the batched tool_use; the second (after
      // tool results loop back) ends the turn.
      let createCallCount = 0;
      vi.mocked(callLlmCreateProxy).mockImplementation(() => {
        createCallCount++;
        if (createCallCount === 1) {
          return fakeStream([
            { type: 'message_complete', content: authoringTurn, stopReason: 'tool_use' },
          ]);
        }
        return fakeStream([
          { type: 'message_complete', content: followUp, stopReason: 'end_turn' },
        ]);
      });

      // Instrumented executor.
      const callOrder: string[] = []; // marker order executeToolRemote was CALLED
      const resolveOrder: string[] = []; // marker order it RESOLVED

      // Concurrency high-water marks — prove serial sections vs parallel rest.
      let activeSections = 0;
      let maxSections = 0;
      let activeParallel = 0;
      let maxParallel = 0;

      // Deferred that the parallel `create_ac` (D) fires when it STARTS; the
      // parallel `create_decision` (B) waits on it. Under the correct
      // Promise.all fan-out both are dispatched together, so B sees D start and
      // proceeds. If the non-section blocks were awaited serially instead, B
      // would block forever waiting for D → the test times out and fails.
      let signalDStarted!: () => void;
      const dStarted = new Promise<void>((r) => {
        signalDStarted = r;
      });

      vi.mocked(executeToolRemote).mockImplementation(async (name: string, input: any) => {
        const marker: string = input.marker;
        callOrder.push(marker);

        if (name === 'add_section') {
          activeSections++;
          maxSections = Math.max(maxSections, activeSections);
          // Yield so a (broken) parallel dispatch would reveal overlap here.
          await tick(5);
          activeSections--;
        } else {
          activeParallel++;
          maxParallel = Math.max(maxParallel, activeParallel);
          if (name === 'create_ac') {
            // D announces it has started so B (waiting) can continue.
            signalDStarted();
            await tick(0);
          } else {
            // B waits for D to start — proves the two ran concurrently. This
            // also forces completion order (D before B) to differ from emit
            // order (B before D), so the result-ordering assertion is meaningful.
            await dStarted;
            await tick(0);
          }
          activeParallel--;
        }

        resolveOrder.push(marker);
        return `result:${marker}`;
      });

      const callbacks: AgentCallbacks = {
        onToolStart: vi.fn(),
        onToolResult: vi.fn(),
        onTextDelta: vi.fn(),
      };

      const graph = createAgentGraph();
      const result = await graph.invoke(
        { messages: [{ role: 'user', content: 'Author the spec' }], docId: null },
        { configurable: { thread_id: 'issue-6-order', callbacks } }
      );

      // Messages: user → assistant (tool_use) → user (tool_results) → assistant (follow-up)
      expect(result.messages).toHaveLength(4);
      const toolResultMsg = result.messages[2];
      expect(toolResultMsg.role).toBe('user');
      const toolResults = toolResultMsg.content as ToolResultBlock[];

      // (b) The reassembled tool_result array is in the ORIGINAL emit order,
      // 1:1 with the tool_use blocks — regardless of completion order.
      expect(toolResults.map((r) => r.tool_use_id)).toEqual(EMIT_ORDER);
      // And every result is matched to the RIGHT tool_use_id (not just ordered).
      for (const r of toolResults) {
        expect(r.content).toBe(`result:${r.tool_use_id}`);
      }

      // (a) The three add_section calls were invoked in emit order A→C→E, not
      // interleaved, and did not overlap (serial execution).
      expect(callOrder.filter((m) => SECTION_MARKERS.includes(m))).toEqual(SECTION_MARKERS);
      expect(maxSections).toBe(1);
      // Sections finish before the parallel fan-out even begins.
      expect(resolveOrder.slice(0, 3)).toEqual(SECTION_MARKERS);

      // (c) The non-section tools were dispatched in parallel (both active at
      // once) — not awaited one-at-a-time.
      expect(maxParallel).toBe(2);
      // Completion order differed from emit order (D resolved before B), so the
      // emit-order result assertion above genuinely exercises the byId
      // reassembly rather than passing by coincidence.
      expect(resolveOrder.indexOf('D')).toBeLessThan(resolveOrder.indexOf('B'));

      // Every block ran exactly once.
      expect(callOrder.sort()).toEqual([...EMIT_ORDER].sort());
    },
    10000
  );
});
