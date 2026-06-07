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

const AC11 = 'mindset-prod/memex-building-itself/specs/spec-190/acs/ac-11';

function fakeSocket() {
  const sent: unknown[] = [];
  let closed = false;
  const sock: SocketLike = {
    binaryType: '',
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
  return {
    enqueue: vi.fn(),
    duck: vi.fn(),
    restore: vi.fn(),
    flush: vi.fn(),
    playedMs: () => 0,
    dispose: vi.fn(),
  };
}

function fakeCapture() {
  return { start: vi.fn(), setMuted: vi.fn(), stop: vi.fn() };
}

// A fake graph whose invoke drives the callbacks the test wants (text + tools).
function fakeGraph(behaviour: (cb: Record<string, (...a: never[]) => void>) => void) {
  return {
    invoke: vi.fn(async (_input: unknown, config: { configurable: { callbacks: Record<string, (...a: never[]) => void> } }) => {
      behaviour(config.configurable.callbacks);
    }),
  } as unknown as ReturnType<typeof import('../guideGraph').createGuideGraph>;
}

function hooks(): OrchestratorHooks & { states: string[]; earcons: string[]; errors: string[] } {
  const states: string[] = [];
  const earcons: string[] = [];
  const errors: string[] = [];
  return {
    states,
    earcons,
    errors,
    setLoopState: (s) => states.push(s),
    playEarcon: (e) => earcons.push(e),
    onError: (m) => errors.push(m),
    onEnded: () => {},
  };
}

const react = {
  navigate: vi.fn(),
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
    sock.sock.onopen?.({}); // socket connects → start_listening
    expect(capture.start).toHaveBeenCalled();
    expect(sock.sent).toContainEqual(JSON.stringify({ type: 'start_listening' }));
    expect(h.states).toContain('listening');
  });

  it('drives a graph turn on a final transcript and speaks the assistant text', async () => {
    tagAc(AC11);
    const sock = fakeSocket();
    const graph = fakeGraph((cb) => cb.onTextDelta?.('This is the Specs board.' as never));
    const h = hooks();
    const orch = createVoiceOrchestratorFactory(react, {
      socketFactory: sock.factory,
      vadEngine: fakeVad().engine,
      capture: fakeCapture(),
      playback: fakePlayback(),
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
    expect(react.navigate).toHaveBeenCalledWith('/ns/mx/standards');
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
