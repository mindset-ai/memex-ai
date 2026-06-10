// spec-214 — half-duplex + barge-in-removal wiring tests for the orchestrator.
// All browser glue is faked (no real audio), exercising the loop's control flow:
//   - dec-1: mic PCM forwarded to STT only while `listening` (ac-6); no commit from
//            non-listening audio (ac-7)
//   - dec-2: a fresh STT session (start_listening) opens on each entry to listening
//            (ac-8)
//   - dec-3: a committed transcript that echoes the just-spoken reply within the
//            cooldown is dropped (ac-10); a dissimilar one survives (ac-11)
//   - dec-4: a VAD onset while speaking neither ducks nor cuts (ac-12); a speech-end
//            while listening still commits (ac-13); Stop halts-and-stays (ac-14)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { createVoiceOrchestratorFactory } from './voiceGuideOrchestrator';
import type { SocketLike, SocketFactory } from './voiceWsClient';
import type { VadEngine } from '../micVad';
import type { OrchestratorHooks } from '../session/orchestrator';
import type { NavigationAdapter } from '../navigation/NavigationAdapter';

const SPEC = 'mindset-prod/memex-building-itself/specs/spec-214';
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;

function fakeSocket() {
  const sent: unknown[] = [];
  let closed = false;
  const sock: SocketLike = {
    binaryType: '',
    readyState: 1, // WebSocket.OPEN
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

// Capture exposes its onFrame callback so a test can feed mic PCM frames and assert
// whether they were forwarded upstream (binary frames land in sock.sent).
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

function fakeGraph(text: string) {
  return {
    invoke: vi.fn(
      async (
        _input: unknown,
        config: { configurable: { callbacks: Record<string, (...a: never[]) => void> } },
      ) => {
        config.configurable.callbacks.onTextDelta?.(text as never);
      },
    ),
  } as unknown as ReturnType<typeof import('../guideGraph').createGuideGraph>;
}

function hooks(): OrchestratorHooks & { states: string[]; earcons: string[] } {
  const states: string[] = [];
  const earcons: string[] = [];
  return {
    states,
    earcons,
    setLoopState: (s) => states.push(s),
    playEarcon: (e) => earcons.push(e),
    onError: () => {},
    onEnded: () => {},
    onTurnComplete: () => {},
  };
}

// spec-222: the orchestrator navigates only through an injected NavigationAdapter.
// These echo/barge tests don't assert navigation, so a minimal adapter suffices.
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
const START_LISTENING = JSON.stringify({ type: 'start_listening' });
const END_UTTERANCE = JSON.stringify({ type: 'end_utterance' });

const isBinary = (s: unknown) => typeof s !== 'string';

beforeEach(() => vi.clearAllMocks());

describe('spec-214 — half-duplex mic→STT gate (dec-1)', () => {
  it('forwards mic PCM only while listening, never while speaking (ac-6, ac-1)', async () => {
    tagAc(AC(6));
    tagAc(AC(1)); // scope: the agent's own captured speech never enters the STT pipeline
    const sock = fakeSocket();
    const vad = fakeVad();
    const capture = fakeCapture();
    const playback = fakePlayback();
    const h = hooks();
    const orch = createVoiceOrchestratorFactory(react, {
      socketFactory: sock.factory,
      vadEngine: vad.engine,
      capture,
      playback,
      graph: fakeGraph('Here you go.'),
      newId: () => 'r1',
    })(h);
    await orch.start(fakeStream);
    sock.sock.onmessage?.(ready); // → listening

    const beforeListen = sock.sent.filter(isBinary).length;
    capture.frame(); // captured while listening → forwarded
    expect(sock.sent.filter(isBinary).length).toBe(beforeListen + 1);

    // Drive a turn to speaking.
    sock.sock.onmessage?.(transcript('how do phases work?'));
    await Promise.resolve();
    await Promise.resolve();
    expect(h.states[h.states.length - 1]).toBe('speaking');

    const whileSpeaking = sock.sent.filter(isBinary).length;
    capture.frame(); // captured echo while speaking → DROPPED
    capture.frame();
    expect(sock.sent.filter(isBinary).length).toBe(whileSpeaking);
  });

  it('does not commit (end_utterance) on a speech-end while the agent is speaking (ac-7, ac-1)', async () => {
    tagAc(AC(7));
    tagAc(AC(1)); // scope: no commit path exists from audio captured outside listening
    const sock = fakeSocket();
    const vad = fakeVad();
    const graph = fakeGraph('A spoken answer.');
    const orch = createVoiceOrchestratorFactory(react, {
      socketFactory: sock.factory,
      vadEngine: vad.engine,
      capture: fakeCapture(),
      playback: fakePlayback(),
      graph,
      newId: () => 'r1',
    })(hooks());
    await orch.start(fakeStream);
    sock.sock.onmessage?.(ready);
    sock.sock.onmessage?.(transcript('a question'));
    await Promise.resolve();
    await Promise.resolve();

    const endsBefore = sock.sent.filter((s) => s === END_UTTERANCE).length;
    // Echo trips the VAD while the agent speaks: onset then end.
    vad.speak(true);
    vad.speak(false);
    expect(sock.sent.filter((s) => s === END_UTTERANCE).length).toBe(endsBefore); // no commit
    expect(graph.invoke).toHaveBeenCalledTimes(1); // no second (self-)turn
  });
});

describe('spec-214 — per-turn STT session (dec-2)', () => {
  it('opens a fresh STT session (start_listening) on each entry to listening (ac-8)', async () => {
    tagAc(AC(8));
    const sock = fakeSocket();
    const playback = fakePlayback();
    const orch = createVoiceOrchestratorFactory(react, {
      socketFactory: sock.factory,
      vadEngine: fakeVad().engine,
      capture: fakeCapture(),
      playback,
      graph: fakeGraph('Answer one.'),
      newId: () => 'r1',
    })(hooks());
    await orch.start(fakeStream);
    sock.sock.onmessage?.(ready); // entry #1 → start_listening
    expect(sock.sent.filter((s) => s === START_LISTENING)).toHaveLength(1);

    // A full turn: speak then drain back to listening.
    sock.sock.onmessage?.(transcript('q?'));
    await Promise.resolve();
    await Promise.resolve();
    sock.sock.onmessage?.(audioFinal('r1'));
    playback.drain(); // entry #2 → fresh start_listening
    expect(sock.sent.filter((s) => s === START_LISTENING)).toHaveLength(2);
  });
});

describe('spec-214 — self-echo guard (dec-3)', () => {
  // Drive one spoken turn, drain it (stamps speakingEndedAt), then feed a follow-up
  // transcript with a controllable clock to land inside / outside the cooldown.
  async function speakThenDrain(text: string, sock: ReturnType<typeof fakeSocket>, playback: ReturnType<typeof fakePlayback>) {
    sock.sock.onmessage?.(ready);
    sock.sock.onmessage?.(transcript('opening question'));
    await Promise.resolve();
    await Promise.resolve();
    sock.sock.onmessage?.(audioFinal('r1'));
    playback.drain(); // speaking → listening; speakingEndedAt stamped
    void text;
  }

  it('drops a committed transcript that echoes the just-spoken reply within cooldown (ac-10)', async () => {
    tagAc(AC(10));
    let clock = 1000;
    const sock = fakeSocket();
    const playback = fakePlayback();
    const graph = fakeGraph('hello there I am Specky');
    const orch = createVoiceOrchestratorFactory(react, {
      socketFactory: sock.factory,
      vadEngine: fakeVad().engine,
      capture: fakeCapture(),
      playback,
      graph,
      newId: () => 'r1',
      now: () => clock,
    })(hooks());
    await orch.start(fakeStream);
    await speakThenDrain('hello there I am Specky', sock, playback);
    expect(graph.invoke).toHaveBeenCalledTimes(1);

    // 200ms later the speaker tail bleeds back, transcribed as (near-)the reply.
    clock = 1200;
    sock.sock.onmessage?.(transcript('hello there I am Specky'));
    await Promise.resolve();
    await Promise.resolve();
    expect(graph.invoke).toHaveBeenCalledTimes(1); // dropped — no self-turn
  });

  it('keeps a dissimilar user turn that lands within the cooldown (ac-11)', async () => {
    tagAc(AC(11));
    let clock = 1000;
    const sock = fakeSocket();
    const playback = fakePlayback();
    const graph = fakeGraph('hello there I am Specky');
    const orch = createVoiceOrchestratorFactory(react, {
      socketFactory: sock.factory,
      vadEngine: fakeVad().engine,
      capture: fakeCapture(),
      playback,
      graph,
      newId: () => 'r1',
      now: () => clock,
    })(hooks());
    await orch.start(fakeStream);
    await speakThenDrain('hello there I am Specky', sock, playback);
    expect(graph.invoke).toHaveBeenCalledTimes(1);

    // A genuine, dissimilar question inside the cooldown window must NOT be dropped.
    clock = 1200;
    sock.sock.onmessage?.(transcript('how do phases work'));
    await Promise.resolve();
    await Promise.resolve();
    expect(graph.invoke).toHaveBeenCalledTimes(2); // genuine turn ran
  });
});

describe('spec-214 — a proactive opening turn does not start a self-conversation (ac-2)', () => {
  it('greets first, then drops its own echoed greeting — no self-turn fires (ac-2, ac-1)', async () => {
    tagAc(AC(2));
    tagAc(AC(1));
    let clock = 5000;
    const sock = fakeSocket();
    const capture = fakeCapture();
    const playback = fakePlayback();
    // The greeting Specky speaks first (the spec-206 first-run welcome scenario).
    const graph = fakeGraph('hello there I am Specky');
    const h = hooks();
    const orch = createVoiceOrchestratorFactory(react, {
      socketFactory: sock.factory,
      vadEngine: fakeVad().engine,
      capture,
      playback,
      graph,
      newId: () => 'r1',
      now: () => clock,
    })(h);

    // Seeded opening context → the guide opens PROACTIVELY (no user speech).
    await orch.start(fakeStream, 'Greet the user warmly by name.');
    sock.sock.onmessage?.(ready); // → runTurn(seed) → speaking the greeting
    await Promise.resolve();
    await Promise.resolve();
    expect(h.states[h.states.length - 1]).toBe('speaking');
    expect(graph.invoke).toHaveBeenCalledTimes(1); // the opening turn only

    // The greeting bleeds from the speakers into the mic WHILE speaking — the gate
    // (dec-1) drops these frames, so they never reach STT.
    const binBefore = sock.sent.filter(isBinary).length;
    capture.frame();
    capture.frame();
    expect(sock.sent.filter(isBinary).length).toBe(binBefore);

    // Greeting finishes; 150ms later the speaker tail is transcribed as (near) the
    // greeting itself — the self-echo guard (dec-3) drops it.
    sock.sock.onmessage?.(audioFinal('r1'));
    playback.drain(); // speaking → listening; speakingEndedAt stamped
    clock = 5150;
    sock.sock.onmessage?.(transcript('hello there I am Specky'));
    await Promise.resolve();
    await Promise.resolve();

    // Specky did NOT answer itself — still just the one opening turn.
    expect(graph.invoke).toHaveBeenCalledTimes(1);
  });
});

describe('spec-214 — voice barge-in removed; Stop is the sole interruption (dec-4)', () => {
  it('does not duck or cut the agent on a VAD onset while speaking (ac-12)', async () => {
    tagAc(AC(12));
    const sock = fakeSocket();
    const vad = fakeVad();
    const playback = fakePlayback();
    const h = hooks();
    const orch = createVoiceOrchestratorFactory(react, {
      socketFactory: sock.factory,
      vadEngine: vad.engine,
      capture: fakeCapture(),
      playback,
      graph: fakeGraph('A long spoken answer.'),
      newId: () => 'r1',
    })(h);
    await orch.start(fakeStream);
    sock.sock.onmessage?.(ready);
    sock.sock.onmessage?.(transcript('q?'));
    await Promise.resolve();
    await Promise.resolve();
    expect(h.states[h.states.length - 1]).toBe('speaking');

    const flushes = playback.flush.mock.calls.length;
    vad.speak(true); // onset over the agent — must be inert (no barge-in)
    expect(h.states[h.states.length - 1]).toBe('speaking'); // not 'ducked'
    expect(playback.flush.mock.calls.length).toBe(flushes); // no cut/flush
    expect(playback.duck).not.toHaveBeenCalled();
    expect(sock.sent).not.toContainEqual(JSON.stringify({ type: 'abort', requestId: 'r1' }));

    // The turn still finishes naturally on drain.
    sock.sock.onmessage?.(audioFinal('r1'));
    playback.drain();
    expect(h.states[h.states.length - 1]).toBe('listening');
  });

  it('commits the user turn (end_utterance) on a speech-end while listening (ac-13, ac-3)', async () => {
    tagAc(AC(13));
    tagAc(AC(3)); // scope: genuine human turn-taking is preserved (the user is still heard)
    const sock = fakeSocket();
    const vad = fakeVad();
    const h = hooks();
    const orch = createVoiceOrchestratorFactory(react, {
      socketFactory: sock.factory,
      vadEngine: vad.engine,
      capture: fakeCapture(),
      playback: fakePlayback(),
      graph: fakeGraph(''),
      newId: () => 'r1',
    })(h);
    await orch.start(fakeStream); // start() enters listening
    vad.speak(true); // user starts
    vad.speak(false); // user stops → end of utterance
    expect(sock.sent).toContainEqual(END_UTTERANCE);
    expect(h.earcons).toContain('ping');
    expect(h.states).toContain('thinking');
  });

  it('Stop halts in-flight TTS and returns to listening without ending the session (ac-14, ac-3)', async () => {
    tagAc(AC(14));
    tagAc(AC(3)); // scope: the user can still interrupt (via Stop) and keep talking
    const sock = fakeSocket();
    const playback = fakePlayback();
    const h = hooks();
    const orch = createVoiceOrchestratorFactory(react, {
      socketFactory: sock.factory,
      vadEngine: fakeVad().engine,
      capture: fakeCapture(),
      playback,
      graph: fakeGraph('Speaking now.'),
      newId: () => 'r1',
    })(h);
    await orch.start(fakeStream);
    sock.sock.onmessage?.(ready);
    sock.sock.onmessage?.(transcript('q?'));
    await Promise.resolve();
    await Promise.resolve();
    expect(h.states[h.states.length - 1]).toBe('speaking');

    orch.interrupt(); // Stop
    expect(sock.sent).toContainEqual(JSON.stringify({ type: 'abort', requestId: 'r1' }));
    expect(playback.flush).toHaveBeenCalled();
    expect(h.states[h.states.length - 1]).toBe('listening');
    expect(sock.isClosed()).toBe(false); // session + mic stay open (halt-and-stay)
  });
});
