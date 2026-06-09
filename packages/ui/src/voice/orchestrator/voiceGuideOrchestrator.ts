// spec-190 t-3 — the browser orchestrator: the live mic→STT→graph→TTS loop that
// implements the VoiceOrchestrator seam (session/orchestrator.ts) the t-8 provider
// drives. It wires together the pieces built across t-1..t-8:
//   - voiceWsClient   — the audio-leg WS (mic PCM up; transcript + TTS audio down)
//   - micPcmCapture   — 16 kHz PCM frames from the granted stream
//   - SileroWorkletVadEngine — local speech onset/end (ac-23)
//   - BargeInController + WebAudioPlayback — duck-then-cut + gapless playback (dec-8)
//   - guideGraph      — the client LangGraph turn (calls the /voice/guide-chat SSE leg)
//   - dispatchGuideUiTool — highlight / navigate (dec-4)
//
// PATH 1 status: the STRUCTURE + wiring are here and unit-tested with fakes; the
// live loop (real audio timing, interim-transcript handling, partial-text TTS,
// cut-truncation into graph state) is tuned + validated ON-DEVICE (t-9), the same
// way t-1's provider and the Silero engine are. All browser glue is injectable so
// the orchestration logic is exercised without real Web Audio / sockets.

import type { GuideElement } from '@memex/shared';
import { SileroWorkletVadEngine } from '../micVad';
import type { VadEngine } from '../micVad';
import { WebAudioPlayback } from '../playbackQueue';
import { BargeInController } from '../bargeIn';
import type { PlaybackSink, CharAlignment } from '../bargeIn';
import { createGuideGraph } from '../guideGraph';
import { dispatchGuideUiTool } from '../guideTools';
import { setGuideAuthToken } from '../guideLlmClient';
import { openVoiceWs, buildVoiceWsUrl, type VoiceWsClient, type SocketFactory } from './voiceWsClient';
import { makePcmCapture, type PcmCapture } from './micPcmCapture';
import type {
  OrchestratorFactory,
  OrchestratorHooks,
  VoiceOrchestrator,
} from '../session/orchestrator';

/** Live screen context, read fresh each turn (screens are state — ac-11). */
export interface ScreenContext {
  screenKey: string | null;
  screenRegistry: GuideElement[];
  namespace: string;
  memex: string;
}

/** React-bound deps the factory needs (only resolvable inside the router tree). */
export interface VoiceOrchestratorReactDeps {
  navigate: (path: string) => void;
  /** spec-206 t-2/dec-1: advance the shared Handhold reveal pointer — the guide's
   *  `advance_demo` tool calls this to walk the demo board during the walkthrough. */
  advanceDemo: () => void;
  /** spec-211 t-3 (dec-1): start the client demo-walkthrough sequencer — the
   *  guide's `start_walkthrough` tool calls this when the user accepts the offer. */
  startWalkthrough: () => void;
  getScreenContext: () => ScreenContext;
  /** Current session bearer token (for the WS connect-query + the SSE leg). */
  authToken: () => string | null;
  tenantBase: () => string | null;
  origin: string;
}

/** Browser glue, injectable so the wiring is testable; defaults are the real impls. */
export interface VoiceOrchestratorGlue {
  socketFactory?: SocketFactory;
  vadEngine?: VadEngine;
  playback?: PlaybackImpl;
  capture?: PcmCapture;
  graph?: ReturnType<typeof createGuideGraph>;
  newId?: () => string;
}

type PlaybackImpl = PlaybackSink & {
  /** Begin a fresh spoken turn: reset gain to full + re-base the played clock. */
  startTurn(): void;
  enqueue(audio: ArrayBuffer): Promise<void> | void;
  /** Fire `cb` once the scheduled audio has finished playing (or immediately if
   *  nothing is queued) — lets the loop hold 'speaking' until the agent is
   *  actually inaudible, not merely until the final chunk has arrived. */
  onDrain(cb: () => void): void;
  dispose(): void;
};

class VoiceGuideOrchestrator implements VoiceOrchestrator {
  private ws: VoiceWsClient | null = null;
  // Browser-resource backed — created LAZILY in start(), never at construction
  // (the constructor runs at provider mount; touching AudioContext there breaks
  // jsdom + wastes resources before a session exists).
  private vad: VadEngine | null = null;
  private playback: PlaybackImpl | null = null;
  private capture: PcmCapture | null = null;
  private barge: BargeInController | null = null;
  private graph: ReturnType<typeof createGuideGraph>;
  private readonly threadId: string;
  private turnAbort: AbortController | null = null;
  private speakingRequestId: string | null = null;
  private stopped = false;
  // spec-200 t-7: a one-shot opening context (a What's New entry) the guide
  // explains proactively on session start. Consumed on ws ready, then cleared.
  private openingContext: string | null = null;
  private readonly newId: () => string;

  constructor(
    private readonly hooks: OrchestratorHooks,
    private readonly react: VoiceOrchestratorReactDeps,
    private readonly glue: VoiceOrchestratorGlue,
  ) {
    this.newId = glue.newId ?? (() => crypto.randomUUID());
    this.threadId = this.newId();
    // The graph touches no browser API, so it's safe at construction.
    // Layer-2 retrieval runs server-side every turn (ac-15), so an explicit
    // search_guide call is rarely needed; return a benign note rather than throw.
    this.graph =
      glue.graph ??
      createGuideGraph({ executeServerTool: async () => '(guide content already retrieved for this turn)' });
  }

  async start(stream: MediaStream, openingContext?: string): Promise<void> {
    // Reset the stopped flag: this orchestrator instance is reused across
    // sessions (the provider memoizes it), and React StrictMode double-invokes the
    // provider's mount effect (mount → cleanup → mount), so stop() may have run at
    // mount — leaving stopped=true. Without this reset every turn would finish with
    // stopped=true and refuse to speak even though the reply was ready.
    this.stopped = false;
    // spec-200 t-7: seed (or clear) the one-shot opening explanation for this session.
    this.openingContext = openingContext ?? null;
    const token = this.react.authToken();
    const base = this.react.tenantBase();
    if (!token || !base) {
      this.hooks.onError('voice session is not authenticated');
      return;
    }
    setGuideAuthToken(token); // the graph's SSE leg uses the same token

    // Lazily build the browser-resource pieces now that a session is starting.
    // Capture non-null locals — TS resets instance-field narrowing after the
    // openVoiceWs / vad.start calls below.
    const vad = (this.vad = this.glue.vadEngine ?? new SileroWorkletVadEngine());
    const playback = (this.playback = this.glue.playback ?? (new WebAudioPlayback() as PlaybackImpl));
    const capture = (this.capture = this.glue.capture ?? makePcmCapture());

    // Barge-in over the playback sink (dec-8).
    this.barge = new BargeInController(playback, {
      abortTts: () => {
        if (this.speakingRequestId) this.ws?.abort(this.speakingRequestId);
      },
      abortLlm: () => this.turnAbort?.abort(),
      onCut: () => {
        // The user cut in — stop speaking and return to listening. Truncating the
        // assistant turn into graph state to the spoken prefix is on-device work.
        this.speakingRequestId = null;
        this.hooks.setLoopState('listening');
      },
    });

    this.ws = openVoiceWs(
      buildVoiceWsUrl(base, token, this.react.origin),
      {
        onReady: () => {
          this.ws?.startListening();
          // spec-200 t-7: if seeded, the guide opens by explaining the entry —
          // a proactive first turn grounded on the entry text (guideContext),
          // requiring no user speech. Consumed once.
          const seed = this.openingContext;
          this.openingContext = null;
          if (seed && !this.stopped) {
            void this.runTurn('Tell me what this update is and why it matters, in a sentence or two.', [seed]);
          }
        },
        onTranscript: (text, isFinal) => {
          if (!isFinal) return;
          if (text.trim()) void this.runTurn(text);
          // Empty committed transcript (a throat-clear / noise tripped the VAD but
          // STT recognized no words). onSpeechEnd already moved us to 'thinking';
          // with no turn to run we'd hang there forever. Recover to listening.
          else if (!this.stopped) this.hooks.setLoopState('listening');
        },
        onAudio: (_requestId, audio, alignment, isFinal) => this.onAudio(audio, alignment, isFinal),
        onError: (message) => this.hooks.onError(message),
        onClose: () => {
          if (!this.stopped) this.hooks.onEnded();
        },
      },
      this.glue.socketFactory,
    );

    await vad.start(stream, (speaking) => (speaking ? this.onSpeechStart() : this.onSpeechEnd()));
    capture.start(stream, (pcm) => this.ws?.sendAudio(pcm));
    this.hooks.setLoopState('listening');
  }

  private onSpeechStart(): void {
    // If the agent is mid-speech, this ducks + arms the cut (dec-8). If idle, it's
    // the user starting their turn — inert for barge-in.
    const wasSpeaking = this.barge?.state === 'speaking' || this.barge?.state === 'ducked';
    this.barge?.onSpeechStart();
    if (wasSpeaking) this.hooks.setLoopState('ducked');
  }

  private onSpeechEnd(): void {
    const wasInterrupting = this.barge?.state === 'ducked';
    this.barge?.onSpeechEnd();
    if (wasInterrupting) return; // transient over agent speech — bargeIn restored it
    // Genuine end of the user's turn: commit STT, ack ping immediately (masks the
    // retrieval + LLM latency, dec-6), and show "thinking".
    this.ws?.endUtterance();
    this.hooks.playEarcon('ping');
    this.hooks.setLoopState('acknowledged');
    this.hooks.setLoopState('thinking');
  }

  private async runTurn(transcript: string, guideContext: string[] = []): Promise<void> {
    // A new user turn supersedes any in-flight agent speech (barge-in, or a fast
    // follow-up before the previous reply finished): stop the old TTS leg and flush
    // its already-queued audio so the previous answer doesn't keep playing over this
    // one. The duck-then-cut timer (dec-8) only fires on SUSTAINED speech; a short
    // interjection ("standards", "stop") ends before it, so without this the old
    // audio plays on. endTurn() resets barge state for the fresh turn.
    if (this.speakingRequestId) {
      this.ws?.abort(this.speakingRequestId);
      this.speakingRequestId = null;
    }
    this.playback?.flush();
    this.barge?.endTurn();

    const { screenKey, screenRegistry, namespace, memex } = this.react.getScreenContext();
    this.turnAbort = new AbortController();
    let assistantText = '';
    try {
      await this.graph.invoke(
        { messages: [{ role: 'user', content: transcript }], screenKey, screenRegistry, guideContext },
        {
          configurable: {
            thread_id: this.threadId,
            signal: this.turnAbort.signal,
            callbacks: {
              onTextDelta: (t: string) => {
                assistantText += t;
              },
              onUiTool: (name: string, _id: string, input: Record<string, unknown>) => {
                dispatchGuideUiTool(name, input, {
                  namespace,
                  memex,
                  navigate: this.react.navigate,
                  advanceDemo: this.react.advanceDemo,
                  startWalkthrough: this.react.startWalkthrough,
                });
              },
            },
          },
        },
      );
    } catch (err) {
      this.hooks.onError(err instanceof Error ? err.message : String(err));
      this.hooks.setLoopState('listening');
      // spec-211 t-1: settle the turn even on error so an awaiting sequencer
      // (dec-1) never hangs.
      this.hooks.onTurnComplete?.();
      return;
    }

    if (assistantText.trim() && !this.stopped) {
      const requestId = this.newId();
      this.speakingRequestId = requestId;
      // Reset the playback turn alongside the barge turn: this restores the gain to
      // full (a prior barge-in duck-then-cut leaves it attenuated) and re-bases the
      // played-ms clock used for truncation. Without it every reply after the first
      // interruption plays at the ducked volume.
      this.playback?.startTurn();
      this.barge?.startTurn();
      this.hooks.setLoopState('speaking');
      this.ws?.speak(requestId, assistantText);
    } else {
      this.hooks.setLoopState('listening');
      // spec-211 t-1: no speech to play (empty/aborted) — settle immediately so an
      // awaiting sequencer advances rather than hangs.
      if (!this.stopped) this.hooks.onTurnComplete?.();
    }
  }

  private onAudio(audio: ArrayBuffer, alignment: CharAlignment | undefined, isFinal: boolean): void {
    void this.playback?.enqueue(audio);
    this.barge?.appendChunk(alignment);
    // isFinal marks the last chunk RECEIVED, but the audio is still playing out of
    // the queue. Stay in 'speaking' — barge armed, the Stop control visible — until
    // playback actually drains, so the user can interrupt for as long as they can
    // hear the agent. onDrain fires immediately if nothing is queued.
    if (isFinal) this.playback?.onDrain(() => this.onPlaybackDrained());
  }

  /** The agent's speech has fully played out (no interruption). Now — not on the
   *  final-chunk receipt — return to listening and disarm the barge. */
  private onPlaybackDrained(): void {
    if (this.stopped) return;
    this.barge?.endTurn();
    this.speakingRequestId = null;
    this.hooks.setLoopState('listening');
    // spec-211 t-1: the agent's spoken turn has fully played out — signal the
    // client tour sequencer so it can advance one phase (dec-1).
    this.hooks.onTurnComplete?.();
  }

  interrupt(): void {
    this.barge?.tapInterrupt();
  }

  // spec-211 t-1 (dec-1): a proactive narration turn for the demo walkthrough.
  // No user speech — mirrors the seeded-opening path (a synthetic prompt + the
  // phase beat as guideContext). Completion is signalled via hooks.onTurnComplete
  // (fired when playback drains, or immediately if there's no socket/speech), so
  // the client sequencer advances one phase only after this narration finishes.
  narratePhase(context: string): void {
    if (this.stopped || !this.ws) {
      // Nothing will speak → settle now so an awaiting sequencer doesn't hang.
      if (!this.stopped) this.hooks.onTurnComplete?.();
      return;
    }
    void this.runTurn(
      'Narrate this walkthrough step for the user in a sentence or two, then give a short cue toward the next step.',
      [context],
    );
  }

  stop(): void {
    this.stopped = true;
    this.turnAbort?.abort();
    try {
      this.ws?.close();
    } catch {
      /* already closing */
    }
    this.capture?.stop();
    this.vad?.stop();
    this.playback?.dispose();
    this.barge?.dispose();
  }
}

/**
 * Build the OrchestratorFactory the t-8 provider consumes. Created inside the
 * router tree (so navigate / route context resolve); the provider passes the
 * granted stream into start().
 */
export function createVoiceOrchestratorFactory(
  react: VoiceOrchestratorReactDeps,
  glue: VoiceOrchestratorGlue = {},
): OrchestratorFactory {
  return (hooks) => new VoiceGuideOrchestrator(hooks, react, glue);
}
