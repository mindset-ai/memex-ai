// spec-190 t-3 — orchestrator WIRING tests (Path 1). All browser glue is faked,
// so this exercises the loop's control flow — not real audio. Proves the client
// graph drives the turn and dispatches UI tools (ac-11), and that the
// WS/VAD/barge-in/playback seams are wired correctly. Live behaviour is validated
// on-device (t-9).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { createVoiceOrchestratorFactory } from './voiceGuideOrchestrator';
import type { SocketLike, SocketFactory } from './voiceWsClient';
import type { VadEngine } from '../micVad';
import type { OrchestratorHooks } from '../session/orchestrator';
import type { NavigationAdapter, NavigateOutcome } from '../navigation/NavigationAdapter';

const AC11 = 'mindset-prod/memex-building-itself/specs/spec-190/acs/ac-11';
const AC23 = 'mindset-prod/memex-building-itself/specs/spec-222/acs/ac-23';

function fakeSocket() {
  const sent: unknown[] = [];
  let closed = false;
  const sock: SocketLike = {
    binaryType: '',
    readyState: 1, // WebSocket.OPEN — sends are gated on this
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
    /** Test helper: simulate the scheduled audio finishing playback. */
    drain: () => {
      const cb = drainCb;
      drainCb = null;
      cb?.();
    },
  };
}

function fakeCapture() {
  return { start: vi.fn(), stop: vi.fn() };
}

// A fake graph whose invoke drives the callbacks the test wants (text + tools).
function fakeGraph(behaviour: (cb: Record<string, (...a: never[]) => void>) => void) {
  return {
    invoke: vi.fn(async (_input: unknown, config: { configurable: { callbacks: Record<string, (...a: never[]) => void> } }) => {
      behaviour(config.configurable.callbacks);
    }),
  } as unknown as ReturnType<typeof import('../guideGraph').createGuideGraph>;
}

function hooks(): OrchestratorHooks & {
  states: string[];
  earcons: string[];
  errors: string[];
  turnCompletes: number;
} {
  const states: string[] = [];
  const earcons: string[] = [];
  const errors: string[] = [];
  const box = { turnCompletes: 0 };
  return {
    states,
    earcons,
    errors,
    get turnCompletes() {
      return box.turnCompletes;
    },
    setLoopState: (s) => states.push(s),
    playEarcon: (e) => earcons.push(e),
    onError: (m) => errors.push(m),
    onEnded: () => {},
    onTurnComplete: () => {
      box.turnCompletes += 1;
    },
  };
}

// spec-222 (ac-9): the orchestrator navigates ONLY through the injected adapter.
// This fake stands in for the app's react-router-backed adapter; its `navigate`
// spy maps the known screen key to the path the old react-router navigate received,
// so the delegation assertion is preserved (was `react.navigate('/ns/mx/standards')`).
const navSpy = vi.fn((screen: string): NavigateOutcome =>
  screen === 'standards-list' ? { ok: true, path: '/ns/mx/standards' } : { ok: false, reason: 'not a navigable screen' },
);
const adapter: NavigationAdapter = {
  resolveScreenKey: () => null,
  currentScreenKey: () => 'specs-list',
  findElement: (id) => document.querySelector<HTMLElement>(`[data-guide-id="${id}"]`),
  navigate: navSpy,
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

beforeEach(() => vi.clearAllMocks());

describe('voice orchestrator wiring (ac-11)', () => {
  it('opens the WS, starts VAD + capture, and starts listening', async () => {
    tagAc(AC11);
    const sock = fakeSocket();
    const vad = fakeVad();
    const capture = fakeCapture();
    const h = hooks();
    const orch = createVoiceOrchestratorFactory(react, {
      socketFactory: sock.factory,
      vadEngine: vad.engine,
      capture,
      playback: fakePlayback(),
      graph: fakeGraph(() => {}),
      newId: () => 'id',
    })(h);

    await orch.start(fakeStream);
    // The server emits {type:"ready"} once auth + config pass — that, not raw
    // socket onopen, is what drives start_listening (so the STT session opens
    // exactly once and never on a soon-to-be-denied socket).
    sock.sock.onmessage?.({ data: JSON.stringify({ type: 'ready' }) });
    expect(capture.start).toHaveBeenCalled();
    expect(sock.sent).toContainEqual(JSON.stringify({ type: 'start_listening' }));
    expect(h.states).toContain('listening');
  });

  it('sends start_listening exactly once (server ready frame only; not on raw onopen)', async () => {
    tagAc(AC11);
    const sock = fakeSocket();
    const orch = createVoiceOrchestratorFactory(react, {
      socketFactory: sock.factory,
      vadEngine: fakeVad().engine,
      capture: fakeCapture(),
      playback: fakePlayback(),
      graph: fakeGraph(() => {}),
      newId: () => 'id',
    })(hooks());
    await orch.start(fakeStream);
    // Raw onopen must NOT trigger start_listening (would double-open STT).
    sock.sock.onopen?.({});
    expect(sock.sent.filter((s) => s === JSON.stringify({ type: 'start_listening' }))).toHaveLength(0);
    // The server ready frame triggers it exactly once.
    sock.sock.onmessage?.({ data: JSON.stringify({ type: 'ready' }) });
    expect(sock.sent.filter((s) => s === JSON.stringify({ type: 'start_listening' }))).toHaveLength(1);
  });

  it('drives a graph turn on a final transcript and speaks the assistant text', async () => {
    tagAc(AC11);
    const sock = fakeSocket();
    const graph = fakeGraph((cb) => cb.onTextDelta?.('This is the Specs board.' as never));
    const playback = fakePlayback();
    const h = hooks();
    const orch = createVoiceOrchestratorFactory(react, {
      socketFactory: sock.factory,
      vadEngine: fakeVad().engine,
      capture: fakeCapture(),
      playback,
      graph,
      newId: () => 'req-1',
    })(h);
    await orch.start(fakeStream);

    // Server commits the utterance → final transcript.
    sock.sock.onmessage?.({ data: JSON.stringify({ type: 'transcript', text: 'how do phases work?', isFinal: true }) });
    await Promise.resolve();
    await Promise.resolve();

    expect(graph.invoke).toHaveBeenCalledTimes(1);
    const sentSpeak = sock.sent.map((s) => (typeof s === 'string' ? JSON.parse(s) : null)).find((m) => m?.type === 'speak');
    expect(sentSpeak).toMatchObject({ type: 'speak', requestId: 'req-1', text: 'This is the Specs board.' });
    expect(h.states).toContain('speaking');
    // Each spoken turn re-bases playback so a prior barge-in duck-then-cut can't
    // leave the gain attenuated (volume must return to full on the next reply).
    expect(playback.startTurn).toHaveBeenCalled();
  });

  it('holds "speaking" until playback drains — not on the final chunk (Stop stays available)', async () => {
    tagAc(AC11);
    const sock = fakeSocket();
    const graph = fakeGraph((cb) => cb.onTextDelta?.('Here is the answer.' as never));
    const playback = fakePlayback();
    const h = hooks();
    const orch = createVoiceOrchestratorFactory(react, {
      socketFactory: sock.factory,
      vadEngine: fakeVad().engine,
      capture: fakeCapture(),
      playback,
      graph,
      newId: () => 'req-1',
    })(h);
    await orch.start(fakeStream);
    sock.sock.onmessage?.({ data: JSON.stringify({ type: 'transcript', text: 'q?', isFinal: true }) });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.states[h.states.length - 1]).toBe('speaking');

    // Final TTS chunk arrives, but the audio is still playing out of the queue —
    // we must NOT drop to listening yet (else the Stop affordance vanishes mid-speech).
    sock.sock.onmessage?.({ data: JSON.stringify({ type: 'audio', requestId: 'req-1', audio: '', isFinal: true }) });
    expect(playback.onDrain).toHaveBeenCalled();
    expect(h.states[h.states.length - 1]).toBe('speaking');

    // Playback finishes → now we return to listening.
    playback.drain();
    expect(h.states[h.states.length - 1]).toBe('listening');
  });

  it('flushes the adapter\'s deferred navigation ONLY on playback drain, never synchronously (spec-222 ac-22)', async () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-222/acs/ac-22');
    // An adapter that DEFERS (like the website's staticSiteNavigation): its
    // onPlaybackDrained hook is the seam the engine calls when the turn finishes.
    const drainSpy = vi.fn();
    const deferringAdapter: NavigationAdapter = { ...adapter, onPlaybackDrained: drainSpy };
    const sock = fakeSocket();
    const graph = fakeGraph((cb) => cb.onTextDelta?.('Opening the docs for you.' as never));
    const playback = fakePlayback();
    const orch = createVoiceOrchestratorFactory({ ...react, adapter: deferringAdapter }, {
      socketFactory: sock.factory,
      vadEngine: fakeVad().engine,
      capture: fakeCapture(),
      playback,
      graph,
      newId: () => 'req-nav',
    })(hooks());
    await orch.start(fakeStream);
    sock.sock.onmessage?.({ data: JSON.stringify({ type: 'transcript', text: 'take me to the docs', isFinal: true }) });
    await Promise.resolve();
    await Promise.resolve();
    // Final chunk received but audio still playing — the page-turn must NOT fire yet.
    sock.sock.onmessage?.({ data: JSON.stringify({ type: 'audio', requestId: 'req-nav', audio: '', isFinal: true }) });
    expect(drainSpy).not.toHaveBeenCalled();
    // Speech drains → the engine flushes the deferred turn exactly once.
    playback.drain();
    expect(drainSpy).toHaveBeenCalledTimes(1);
  });

  it('seeds a proactive opening turn from openingContext on ws ready (spec-200 t-7 / ac-15)', async () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-200/acs/ac-15');
    const sock = fakeSocket();
    const graph = fakeGraph((cb) => cb.onTextDelta?.('This update lets you see what shipped.' as never));
    const h = hooks();
    const orch = createVoiceOrchestratorFactory(react, {
      socketFactory: sock.factory,
      vadEngine: fakeVad().engine,
      capture: fakeCapture(),
      playback: fakePlayback(),
      graph,
      newId: () => 'seed-1',
    })(h);

    const seed = "What's New — See what shipped. What shipped: A feed. Why it matters: You stay current.";
    await orch.start(fakeStream, seed);

    // ws ready → the guide opens PROACTIVELY (no transcript), grounded on the seed.
    sock.sock.onmessage?.({ data: JSON.stringify({ type: 'ready' }) });
    await Promise.resolve();
    await Promise.resolve();

    expect(graph.invoke).toHaveBeenCalledTimes(1);
    const input = graph.invoke.mock.calls[0][0] as { guideContext: string[] };
    expect(input.guideContext).toEqual([seed]); // entry text seeded for Specky to explain
    const spoke = sock.sent.map((s) => (typeof s === 'string' ? JSON.parse(s) : null)).find((m) => m?.type === 'speak');
    expect(spoke?.text).toContain('see what shipped');
  });

  it('narratePhase drives a proactive turn seeded with the phase beat, and speaks (spec-211 ac-7)', async () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-211/acs/ac-7');
    const sock = fakeSocket();
    const graph = fakeGraph((cb) => cb.onTextDelta?.('This spec is in draft — it captures the why.' as never));
    const h = hooks();
    const orch = createVoiceOrchestratorFactory(react, {
      socketFactory: sock.factory,
      vadEngine: fakeVad().engine,
      capture: fakeCapture(),
      playback: fakePlayback(),
      graph,
      newId: () => 'narrate-1',
    })(h);
    await orch.start(fakeStream);
    sock.sock.onmessage?.({ data: JSON.stringify({ type: 'ready' }) });

    const beat = '**Specify the why.** The idea is captured as a Spec.';
    orch.narratePhase(beat);
    await Promise.resolve();
    await Promise.resolve();

    // A proactive turn ran with the beat as guideContext (no user transcript).
    expect(graph.invoke).toHaveBeenCalledTimes(1);
    const input = graph.invoke.mock.calls[0][0] as { guideContext: string[] };
    expect(input.guideContext).toEqual([beat]);
    const spoke = sock.sent.map((s) => (typeof s === 'string' ? JSON.parse(s) : null)).find((m) => m?.type === 'speak');
    expect(spoke?.text).toContain('draft');
  });

  it('fires onTurnComplete when the narration turn finishes playing (spec-211 ac-8)', async () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-211/acs/ac-8');
    const sock = fakeSocket();
    const graph = fakeGraph((cb) => cb.onTextDelta?.('Draft captures the why.' as never));
    const playback = fakePlayback();
    const h = hooks();
    const orch = createVoiceOrchestratorFactory(react, {
      socketFactory: sock.factory,
      vadEngine: fakeVad().engine,
      capture: fakeCapture(),
      playback,
      graph,
      newId: () => 'narrate-1',
    })(h);
    await orch.start(fakeStream);
    sock.sock.onmessage?.({ data: JSON.stringify({ type: 'ready' }) });

    orch.narratePhase('beat');
    await Promise.resolve();
    await Promise.resolve();

    // Speaking, not yet complete — the signal must wait for playback to drain.
    expect(h.turnCompletes).toBe(0);
    sock.sock.onmessage?.({ data: JSON.stringify({ type: 'audio', requestId: 'narrate-1', audio: '', isFinal: true }) });
    expect(h.turnCompletes).toBe(0); // final chunk received, audio still playing
    playback.drain(); // audio finished playing out
    expect(h.turnCompletes).toBe(1);
  });

  it('does NOT seed an opening turn without openingContext (additive — ac-15)', async () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-200/acs/ac-15');
    const sock = fakeSocket();
    const graph = fakeGraph(() => {});
    const orch = createVoiceOrchestratorFactory(react, {
      socketFactory: sock.factory,
      vadEngine: fakeVad().engine,
      capture: fakeCapture(),
      playback: fakePlayback(),
      graph,
      newId: () => 'id',
    })(hooks());
    await orch.start(fakeStream); // no opening context — today's behaviour
    sock.sock.onmessage?.({ data: JSON.stringify({ type: 'ready' }) });
    await Promise.resolve();
    await Promise.resolve();
    expect(graph.invoke).not.toHaveBeenCalled(); // waits for the user to speak
  });

  it('dispatches a navigate UI tool through the app router', async () => {
    tagAc(AC11);
    const sock = fakeSocket();
    const graph = fakeGraph((cb) => cb.onUiTool?.('navigate' as never, 'tid' as never, { screen: 'standards-list' } as never));
    const orch = createVoiceOrchestratorFactory(react, {
      socketFactory: sock.factory,
      vadEngine: fakeVad().engine,
      capture: fakeCapture(),
      playback: fakePlayback(),
      graph,
      newId: () => 'id',
    })(hooks());
    await orch.start(fakeStream);
    sock.sock.onmessage?.({ data: JSON.stringify({ type: 'transcript', text: 'take me to standards', isFinal: true }) });
    await Promise.resolve();
    // The engine delegates to the adapter by SCREEN KEY; the adapter (app-side)
    // owns key→path resolution and returns the outcome.
    expect(navSpy).toHaveBeenCalledWith('standards-list');
  });

  it('end-of-utterance commits STT, plays the ack ping, and shows thinking', async () => {
    tagAc(AC11);
    const sock = fakeSocket();
    const vad = fakeVad();
    const h = hooks();
    const orch = createVoiceOrchestratorFactory(react, {
      socketFactory: sock.factory,
      vadEngine: vad.engine,
      capture: fakeCapture(),
      playback: fakePlayback(),
      graph: fakeGraph(() => {}),
      newId: () => 'id',
    })(h);
    await orch.start(fakeStream);

    vad.speak(true); // user starts talking (agent idle → no barge-in)
    vad.speak(false); // user stops → end of utterance
    expect(sock.sent).toContainEqual(JSON.stringify({ type: 'end_utterance' }));
    expect(h.earcons).toContain('ping');
    expect(h.states).toContain('thinking');
  });

  it('recovers to listening on an empty committed transcript (does not hang in thinking)', async () => {
    tagAc(AC11);
    const sock = fakeSocket();
    const graph = fakeGraph(() => {});
    const h = hooks();
    const orch = createVoiceOrchestratorFactory(react, {
      socketFactory: sock.factory,
      vadEngine: fakeVad().engine,
      capture: fakeCapture(),
      playback: fakePlayback(),
      graph,
      newId: () => 'id',
    })(h);
    await orch.start(fakeStream);

    // Empty final transcript (noise/throat-clear tripped the VAD; STT found no words).
    sock.sock.onmessage?.({ data: JSON.stringify({ type: 'transcript', text: '   ', isFinal: true }) });
    await Promise.resolve();

    expect(graph.invoke).not.toHaveBeenCalled(); // no turn to run
    expect(h.states[h.states.length - 1]).toBe('listening'); // recovered, not stuck
  });

  it('errors cleanly when the session is not authenticated', async () => {
    tagAc(AC11);
    const h = hooks();
    const orch = createVoiceOrchestratorFactory(
      { ...react, authToken: () => null },
      { socketFactory: fakeSocket().factory, vadEngine: fakeVad().engine, capture: fakeCapture(), playback: fakePlayback(), graph: fakeGraph(() => {}), newId: () => 'id' },
    )(h);
    await orch.start(fakeStream);
    expect(h.errors.length).toBeGreaterThan(0);
  });

  it('stop() tears down socket, vad, capture, and playback', async () => {
    tagAc(AC11);
    // spec-222 ac-23: on a website cross-page nav the session ends CLEANLY — the WS
    // is closed and the capture/VAD released (the mic-stream tracks are stopped by
    // the session provider's releaseStream; the cross-page page-turn itself is the
    // deferred performPageLoad of staticSiteNavigation, t-4). No session-resume.
    tagAc(AC23);
    const sock = fakeSocket();
    const vad = fakeVad();
    const capture = fakeCapture();
    const playback = fakePlayback();
    const orch = createVoiceOrchestratorFactory(react, {
      socketFactory: sock.factory,
      vadEngine: vad.engine,
      capture,
      playback,
      graph: fakeGraph(() => {}),
      newId: () => 'id',
    })(hooks());
    await orch.start(fakeStream);
    orch.stop();
    expect(sock.isClosed()).toBe(true);
    expect(vad.engine.stop).toHaveBeenCalled();
    expect(capture.stop).toHaveBeenCalled();
    expect(playback.dispose).toHaveBeenCalled();
  });
});
