// spec-264 t-2 (dec-2) — Stop is a true hard-flush. Two failure modes the fix closes,
// both exercised here against faked browser glue (no real audio):
//   1. Residual TTS audio: after a Stop, chunks the server had already sent for the
//      aborted request keep arriving over the WS and play out the tail of the
//      previous answer. onAudio now drops any chunk whose requestId is not the
//      current speakingRequestId (which interrupt() nulls). [ac-8 / ac-2]
//   2. Dangling turn in history: an interrupt mid-turn must leave NO partial assistant
//      turn AND no orphaned user turn behind, while preserving completed prior turns.
//      The orchestrator owns the committed history and commits a turn only if it
//      finished un-interrupted, so the next turn starts clean. [ac-9 / ac-2]

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { createVoiceOrchestratorFactory } from './voiceGuideOrchestrator';
import type { SocketLike, SocketFactory } from './voiceWsClient';
import type { VadEngine } from '../micVad';
import type { OrchestratorHooks } from '../session/orchestrator';
import type { NavigationAdapter } from '../navigation/NavigationAdapter';

const SPEC = 'mindset-prod/memex-building-itself/specs/spec-264';
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;

function fakeSocket() {
  const sent: unknown[] = [];
  let closed = false;
  const sock: SocketLike = {
    binaryType: '',
    readyState: 1,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send: (d) => sent.push(d),
    close: () => {
      closed = true;
    },
  };
  return { sock, sent, factory: (() => sock) as SocketFactory, isClosed: () => closed };
}

function fakeVad() {
  let onSpeech: ((s: boolean) => void) | null = null;
  const engine: VadEngine = {
    start: (_stream, cb) => {
      onSpeech = cb;
    },
    stop: vi.fn(),
  };
  return { engine, speak: (s: boolean) => onSpeech?.(s) };
}

function fakePlayback() {
  let drainCb: (() => void) | null = null;
  return {
    startTurn: vi.fn(),
    enqueue: vi.fn(),
    duck: vi.fn(),
    restore: vi.fn(),
    flush: vi.fn(() => {
      drainCb = null;
    }),
    playedMs: () => 0,
    onDrain: vi.fn((cb: () => void) => {
      drainCb = cb;
    }),
    dispose: vi.fn(),
    drain: () => {
      const cb = drainCb;
      drainCb = null;
      cb?.();
    },
  };
}

function fakeCapture() {
  let onFrame: ((pcm: ArrayBuffer) => void) | null = null;
  return {
    start: (_stream: MediaStream, cb: (pcm: ArrayBuffer) => void) => {
      onFrame = cb;
    },
    stop: vi.fn(),
    frame: () => onFrame?.(new ArrayBuffer(8)),
  };
}

interface GraphCall {
  messages: unknown;
}

/** A graph whose turns stay pending until completed/aborted, so a test can interrupt
 *  a turn mid-flight. Records the `messages` input of every invoke for assertions. */
function controllableGraph() {
  const calls: GraphCall[] = [];
  const pending: Array<{
    config: { configurable: { callbacks: Record<string, (...a: never[]) => void>; signal?: AbortSignal } };
    resolve: () => void;
  }> = [];
  const invoke = vi.fn((input: GraphCall, config: (typeof pending)[number]['config']) => {
    calls.push({ messages: (input as { messages: unknown }).messages });
    return new Promise<void>((resolve, reject) => {
      pending.push({ config, resolve });
      config.configurable.signal?.addEventListener('abort', () =>
        reject(new DOMException('Aborted', 'AbortError')),
      );
    });
  });
  const complete = (i: number, text: string) => {
    const e = pending[i];
    e.config.configurable.callbacks.onTextDelta?.(text as never);
    (e.config.configurable.callbacks.onAssistantTurnComplete as ((c: unknown) => void) | undefined)?.([
      { type: 'text', text },
    ]);
    e.resolve();
  };
  return { graph: { invoke } as unknown as ReturnType<typeof import('../guideGraph').createGuideGraph>, calls, complete };
}

function hooks(): OrchestratorHooks & { states: string[] } {
  const states: string[] = [];
  return {
    states,
    setLoopState: (s) => states.push(s),
    playEarcon: () => {},
    onError: () => {},
    onEnded: () => {},
    onTurnComplete: () => {},
  };
}

const adapter: NavigationAdapter = {
  resolveScreenKey: () => null,
  currentScreenKey: () => 'specs-list',
  findElement: () => null,
  navigate: () => ({ ok: true, path: '/ns/mx/specs' }),
};

const react = {
  adapter,
  advanceDemo: vi.fn(),
  startWalkthrough: vi.fn(),
  authToken: () => 'tok',
  tenantBase: () => '/api/ns/mx',
  origin: 'http://localhost',
  getScreenContext: () => ({ screenKey: 'specs-list', screenRegistry: [], namespace: 'ns', memex: 'mx' }),
};

const fakeStream = {} as MediaStream;
const ready = { data: JSON.stringify({ type: 'ready' }) };
const transcript = (text: string) => ({ data: JSON.stringify({ type: 'transcript', text, isFinal: true }) });
const audioFinal = (requestId: string) => ({ data: JSON.stringify({ type: 'audio', requestId, audio: '', isFinal: true }) });

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

beforeEach(() => vi.clearAllMocks());

describe('spec-264 t-2: Stop drops residual TTS audio (dec-2 / ac-8, ac-2)', () => {
  it('ignores TTS chunks for a request that Stop has aborted — no tail of the previous answer', async () => {
    tagAc(AC(8)); // impl: Stop aborts TTS + flushes immediately, not via a confirm gate
    tagAc(AC(2)); // scope: cuts current audio, no leftover tail
    const sock = fakeSocket();
    const playback = fakePlayback();
    const g = controllableGraph();
    const h = hooks();
    const orch = createVoiceOrchestratorFactory(react, {
      socketFactory: sock.factory,
      vadEngine: fakeVad().engine,
      capture: fakeCapture(),
      playback,
      graph: g.graph,
      newId: () => 'r1',
    })(h);

    await orch.start(fakeStream);
    sock.sock.onmessage?.(ready);
    sock.sock.onmessage?.(transcript('how do phases work?')); // turn 0
    await flush;
    g.complete(0, 'Phases run draft to done.'); // → speaking, speakingRequestId = 'r1'
    await flush;
    expect(h.states[h.states.length - 1]).toBe('speaking');

    const enqueuedBeforeStop = playback.enqueue.mock.calls.length;

    orch.interrupt(); // Stop
    // Hard-flush primitives fired immediately (NOT routed through a confirm gate):
    expect(sock.sent).toContainEqual(JSON.stringify({ type: 'abort', requestId: 'r1' }));
    expect(playback.flush).toHaveBeenCalled();
    expect(playback.duck).not.toHaveBeenCalled(); // no spec-246 duck-then-confirm
    expect(h.states[h.states.length - 1]).toBe('listening');
    expect(sock.isClosed()).toBe(false); // halt-and-stay: session + mic stay open

    // A chunk the server had already sent for the aborted 'r1' now arrives — it must
    // be DROPPED, not enqueued (else it plays the tail of the abandoned answer).
    sock.sock.onmessage?.(audioFinal('r1'));
    expect(playback.enqueue.mock.calls.length).toBe(enqueuedBeforeStop);
  });
});

describe('spec-264 t-2: Stop drops the in-flight turn from history (dec-2 / ac-9, ac-2)', () => {
  it('an interrupted turn leaves no dangling user/partial assistant; completed prior turns are preserved', async () => {
    tagAc(AC(9)); // impl: in-flight/partial turn removed; completed prior turns intact
    tagAc(AC(2)); // scope: next instruction acted on directly, with no tail
    const sock = fakeSocket();
    const playback = fakePlayback();
    const g = controllableGraph();
    const orch = createVoiceOrchestratorFactory(react, {
      socketFactory: sock.factory,
      vadEngine: fakeVad().engine,
      capture: fakeCapture(),
      playback,
      graph: g.graph,
      newId: () => 'r1',
      now: () => 1000, // fixed clock; the self-echo guard is irrelevant to dissimilar turns
    })(hooks());

    await orch.start(fakeStream);
    sock.sock.onmessage?.(ready);

    // Turn 1 — completes cleanly → committed to history.
    sock.sock.onmessage?.(transcript('what is a spec')); // invoke #0
    await flush;
    g.complete(0, 'A spec is a unit of work.');
    await flush;
    // Drain turn 1's speech back to listening.
    sock.sock.onmessage?.(audioFinal('r1'));
    playback.drain();

    // Turn 2 — interrupted MID-flight (never completes) → must NOT be committed.
    sock.sock.onmessage?.(transcript('tell me about phases')); // invoke #1
    await flush;
    orch.interrupt(); // Stop while the answer is still being produced
    await flush;

    // Turn 3 — the user's next instruction.
    sock.sock.onmessage?.(transcript('how do I sign in')); // invoke #2
    await flush;

    // Turn 2's input still carried the completed turn 1 (history preserved).
    expect(g.calls[1].messages).toEqual([
      { role: 'user', content: 'what is a spec' },
      { role: 'assistant', content: [{ type: 'text', text: 'A spec is a unit of work.' }] },
      { role: 'user', content: 'tell me about phases' },
    ]);

    // Turn 3's input has turn 1 preserved but NO trace of the interrupted turn 2 —
    // neither its user utterance nor a partial assistant reply. Specky goes straight
    // to the new instruction instead of resuming the abandoned answer.
    expect(g.calls[2].messages).toEqual([
      { role: 'user', content: 'what is a spec' },
      { role: 'assistant', content: [{ type: 'text', text: 'A spec is a unit of work.' }] },
      { role: 'user', content: 'how do I sign in' },
    ]);
  });
});
