// spec-190 t-3 — the browser orchestrator: the live mic→STT→graph→TTS loop that
// implements the VoiceOrchestrator seam (session/orchestrator.ts) the t-8 provider
// drives. It wires together the pieces built across t-1..t-8:
//   - voiceWsClient   — the audio-leg WS (mic PCM up; transcript + TTS audio down)
//   - micPcmCapture   — 16 kHz PCM frames from the granted stream
//   - SileroWorkletVadEngine — local speech onset/end (ac-23)
//   - WebAudioPlayback — gapless TTS playback
//   - guideGraph      — the client LangGraph turn (calls the /voice/guide-chat SSE leg)
//   - dispatchGuideUiTool — highlight / navigate (dec-4)
//
// spec-214 (dec-1/dec-3/dec-4): the loop is HALF-DUPLEX. Mic PCM is forwarded to
// the STT leg ONLY while the loop is `listening` (dec-1) — Specky's own speech can
// never be transcribed and answered, which was the self-talk loop. A fresh STT
// session is opened per human turn (dec-2). Voice barge-in is REMOVED (dec-4,
// supersedes spec-190/dec-8): the VAD no longer ducks/cuts the agent; it endpoints
// only the user's turn during `listening`. Stop (interrupt) is the sole
// interruption — it halts TTS and returns to listening, session live. A self-echo
// guard (dec-3) drops any committed transcript that echoes the just-spoken reply
// within a short cooldown, covering the momentary drain→listening tail window.
//
// PATH 1 status: the STRUCTURE + wiring are here and unit-tested with fakes; the
// live loop (real audio timing, interim-transcript handling, partial-text TTS) is
// tuned + validated ON-DEVICE (t-9 / spec-214 t-4), the same way t-1's provider and
// the Silero engine are. All browser glue is injectable so the orchestration logic
// is exercised without real Web Audio / sockets.

import type {
  GuideElement,
  GuideScreenSummary,
  NavigationAdapter,
} from '../navigation/NavigationAdapter';
import { SileroWorkletVadEngine } from '../micVad';
import type { VadEngine } from '../micVad';
import { WebAudioPlayback } from '../playbackQueue';
import type { PlaybackSink } from '../bargeIn';
import { createGuideGraph } from '../guideGraph';
import type { MessageParam, ContentBlock } from '../agent-types';

// spec-214 dec-3 — self-echo guard tuning. A committed transcript is dropped as the
// agent's own echo ONLY when BOTH hold: it lands within the cooldown after speaking
// ended, AND a high fraction of its tokens appear in the just-spoken reply. Both
// gates together keep a genuine (dissimilar) user turn that happens to land in the
// window — and a similar one that lands much later — from being swallowed.
const SELF_ECHO_COOLDOWN_MS = 1500;
const SELF_ECHO_CONTAINMENT_THRESHOLD = 0.6;

/** Normalise to lowercase alphanumeric word tokens for the self-echo containment check. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}
import { dispatchGuideUiTool } from '../guideTools';
import type { GuideCapabilities } from '../guideTools';
import { setGuideAuthToken } from '../guideLlmClient';
import { getGuideBackend } from '../backend';
import { openVoiceWs, buildVoiceWsUrl, type VoiceWsClient, type SocketFactory } from './voiceWsClient';
import { makePcmCapture, type PcmCapture } from './micPcmCapture';
import type {
  OrchestratorFactory,
  OrchestratorHooks,
  VoiceOrchestrator,
} from '../session/orchestrator';
import type { VoiceLoopState } from '../session/voiceSessionModel';

/** Live screen context, read fresh each turn (screens are state — ac-11). */
export interface ScreenContext {
  screenKey: string | null;
  screenRegistry: GuideElement[];
  /** The host's complete navigable-screen list (site map), when the adapter
   *  supplies allScreens(). Optional — the in-app host omits it. */
  screens?: GuideScreenSummary[];
  namespace: string;
  memex: string;
}

/** React-bound deps the factory needs (only resolvable inside the router tree). */
export interface VoiceOrchestratorReactDeps {
  /** spec-222 (ac-9): the injected navigation seam. The host supplies a
   *  react-router-backed adapter; the engine never imports react-router/@memex/shared.
   *  The guide's `navigate` tool delegates to `adapter.navigate(screen)`. */
  adapter: NavigationAdapter;
  /** spec-206 t-2/dec-1: advance the shared Handhold reveal pointer — the guide's
   *  `advance_demo` tool calls this to walk the demo board during the walkthrough. */
  advanceDemo: () => void;
  /** spec-211 t-3 (dec-1): start the client demo-walkthrough sequencer — the
   *  guide's `start_walkthrough` tool calls this when the user accepts the offer. */
  startWalkthrough: () => void;
  /** spec-222 t-6 (dec-5): host capability flags. The app sets `{ walkthrough: true }`;
   *  the website omits it so the demo tools stay inert (ac-6, ac-18). */
  capabilities?: GuideCapabilities;
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
  /** Injectable clock for the self-echo cooldown (dec-3); defaults to Date.now. */
  now?: () => number;
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
  private graph: ReturnType<typeof createGuideGraph>;
  private readonly threadId: string;
  private turnAbort: AbortController | null = null;
  private speakingRequestId: string | null = null;
  private stopped = false;
  // spec-264 t-2 (dec-2): the orchestrator OWNS the committed conversation history —
  // the user+assistant of COMPLETED turns only. Each turn invokes the graph with a
  // FRESH per-turn thread and this history as input, then commits the turn's messages
  // only if it finished without being interrupted/superseded. So a Stop (or a fast
  // follow-up) drops the in-flight turn entirely and the next utterance starts clean,
  // with no dangling user turn left in a checkpoint for the model to keep answering.
  private committedMessages: MessageParam[] = [];
  // Monotonic turn id. runTurn stamps `currentTurnId` at entry; interrupt() clears it
  // and a superseding runTurn replaces it, so an in-flight turn can detect (after its
  // async graph.invoke resolves) that it was abandoned and neither speak nor commit.
  private turnSeq = 0;
  private currentTurnId: number | null = null;
  // spec-214 dec-1: the live loop state, tracked here so the mic→STT gate can read
  // it synchronously. Mic PCM is forwarded to STT ONLY while this is 'listening'.
  private loopState: VoiceLoopState = 'idle';
  // spec-214 dec-3: token set of the reply most recently spoken, + when speaking
  // last ended — together they drive the self-echo guard's containment + cooldown.
  private lastSpokenTokens: Set<string> = new Set();
  private speakingEndedAt: number | null = null;
  // spec-200 t-7: a one-shot opening context (a What's New entry) the guide
  // explains proactively on session start. Consumed on ws ready, then cleared.
  private openingContext: string | null = null;
  private readonly newId: () => string;
  private readonly now: () => number;

  constructor(
    private readonly hooks: OrchestratorHooks,
    private readonly react: VoiceOrchestratorReactDeps,
    private readonly glue: VoiceOrchestratorGlue,
  ) {
    this.newId = glue.newId ?? (() => crypto.randomUUID());
    this.now = glue.now ?? (() => Date.now());
    this.threadId = this.newId();
    // The graph touches no browser API, so it's safe at construction.
    // Layer-2 retrieval runs server-side every turn (ac-15), so an explicit
    // search_guide call is rarely needed; return a benign note rather than throw.
    this.graph =
      glue.graph ??
      createGuideGraph({
        executeServerTool: async () => '(guide content already retrieved for this turn)',
        // After a client tool runs (navigate can soft-nav an SPA host mid-turn),
        // the graph re-reads the live screen so the post-tool LLM call carries
        // the NEW screen's context, not the turn-start snapshot.
        getScreenContext: () => this.react.getScreenContext(),
      });
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
    this.playback = this.glue.playback ?? (new WebAudioPlayback() as PlaybackImpl);
    const capture = (this.capture = this.glue.capture ?? makePcmCapture());

    this.ws = openVoiceWs(
      buildVoiceWsUrl(base, token, this.react.origin, getGuideBackend().voicePath),
      {
        onReady: () => {
          // spec-200 t-7: if seeded, the guide opens by explaining the entry —
          // a proactive first turn grounded on the entry text (guideContext),
          // requiring no user speech. Consumed once. While it speaks the mic→STT
          // gate (dec-1) is closed, so the opening monologue can't be self-heard.
          const seed = this.openingContext;
          this.openingContext = null;
          if (seed && !this.stopped) {
            void this.runTurn('Tell me what this update is and why it matters, in a sentence or two.', [seed]);
          } else if (!this.stopped) {
            // No opening turn — open the first human-turn STT session and listen.
            this.beginListeningTurn();
          }
        },
        onTranscript: (text, isFinal) => {
          if (!isFinal) return;
          const t = text.trim();
          // spec-214 dec-3: drop the agent's own echo — a transcript that lands in
          // the post-speaking cooldown AND largely repeats the just-spoken reply is
          // the speaker tail bleeding into the fresh listening window, not the user.
          if (t && this.isSelfEcho(t)) {
            if (!this.stopped) this.beginListeningTurn();
            return;
          }
          if (t) void this.runTurn(t);
          // Empty committed transcript (a throat-clear / noise tripped the VAD but
          // STT recognized no words). onSpeechEnd already moved us to 'thinking';
          // with no turn to run we'd hang there forever. Recover to listening
          // (re-opening the STT session for the next human turn — dec-2).
          else if (!this.stopped) this.beginListeningTurn();
        },
        onAudio: (requestId, audio, _alignment, isFinal) => this.onAudio(requestId, audio, isFinal),
        onError: (message) => this.hooks.onError(message),
        onClose: () => {
          if (!this.stopped) this.hooks.onEnded();
        },
      },
      this.glue.socketFactory,
    );

    await vad.start(stream, (speaking) => (speaking ? this.onSpeechStart() : this.onSpeechEnd()));
    // spec-214 dec-1: half-duplex gate. Forward mic PCM to the STT leg ONLY while
    // the loop is `listening`. While the agent is speaking/thinking, its own
    // speaker output (echo) is captured but never sent upstream — so it cannot be
    // transcribed and answered (the self-talk loop). The local VAD still runs over
    // the full stream for user-turn endpointing.
    capture.start(stream, (pcm) => {
      if (this.loopState === 'listening') this.ws?.sendAudio(pcm);
    });
    // Initial state: `listening` so onSpeechEnd endpoints and the gate is open
    // before the ws `ready` frame arrives (ready then re-opens the STT session via
    // beginListeningTurn, or runs the seeded opening turn).
    this.enterState('listening');
  }

  /** spec-214 dec-1/dec-2: enter the live loop state and keep the internal
   *  `loopState` (which the mic→STT gate reads) in lockstep with the pill's. */
  private enterState(state: VoiceLoopState): void {
    this.loopState = state;
    this.hooks.setLoopState(state);
  }

  /** spec-214 dec-2: begin a human turn — open a FRESH STT session for it (so each
   *  utterance is bounded to one human turn and never carries agent audio) and
   *  enter `listening` (opening the mic→STT gate). */
  private beginListeningTurn(): void {
    if (this.stopped) return;
    this.ws?.startListening();
    this.enterState('listening');
  }

  private onSpeechStart(): void {
    // spec-214 dec-4: voice barge-in is removed (supersedes spec-190/dec-8). While
    // the agent is speaking, a VAD onset is IGNORED — no duck, no cut; the turn
    // plays to completion. During `listening` it's the user starting their turn;
    // the commit happens on speech END (onSpeechEnd). Nothing to do on onset.
  }

  private onSpeechEnd(): void {
    // Only a speech-end DURING the user's listening turn ends an utterance. An onset/
    // end while the agent is speaking or thinking is echo or noise (the gate already
    // dropped its audio) — ignore it so it can't commit a turn (dec-1/dec-4).
    if (this.loopState !== 'listening') return;
    // Genuine end of the user's turn: commit STT, ack ping immediately (masks the
    // retrieval + LLM latency, dec-6), and show "thinking".
    this.ws?.endUtterance();
    this.hooks.playEarcon('ping');
    this.enterState('acknowledged');
    this.enterState('thinking');
  }

  /** spec-214 dec-3: is this committed transcript the agent's own echo? True only
   *  when it lands within the cooldown after speaking ended AND a high fraction of
   *  its tokens appear in the just-spoken reply. Both gates required so a genuine,
   *  dissimilar user turn in the window — or a similar turn long after — survives. */
  private isSelfEcho(committed: string): boolean {
    if (this.speakingEndedAt === null) return false;
    if (this.now() - this.speakingEndedAt > SELF_ECHO_COOLDOWN_MS) return false;
    if (this.lastSpokenTokens.size === 0) return false;
    const tokens = tokenize(committed);
    if (tokens.length === 0) return false;
    let inSpoken = 0;
    for (const tok of tokens) if (this.lastSpokenTokens.has(tok)) inSpoken++;
    return inSpoken / tokens.length >= SELF_ECHO_CONTAINMENT_THRESHOLD;
  }

  private async runTurn(transcript: string, guideContext: string[] = []): Promise<void> {
    // A new turn supersedes any in-flight agent speech (a fast follow-up before the
    // previous reply finished, or a Stop→ask): stop the old TTS leg and flush its
    // already-queued audio so the previous answer doesn't keep playing over this one.
    if (this.speakingRequestId) {
      this.ws?.abort(this.speakingRequestId);
      this.speakingRequestId = null;
    }
    this.playback?.flush();

    // spec-264 t-2 (dec-2): claim this turn. A later interrupt() (Stop) or a
    // superseding runTurn moves `currentTurnId`, so when THIS invoke resolves we can
    // tell it was abandoned and skip both speaking and committing it to history.
    const turnId = ++this.turnSeq;
    this.currentTurnId = turnId;
    const userMessage: MessageParam = { role: 'user', content: transcript };

    const { screenKey, screenRegistry, screens } = this.react.getScreenContext();
    this.turnAbort = new AbortController();
    let assistantText = '';
    let finalAssistantContent: ContentBlock[] | null = null;
    try {
      await this.graph.invoke(
        {
          // spec-264 t-2 (dec-2): the orchestrator-owned history is the cross-turn
          // source of truth — send prior COMPLETED turns + this user turn on a FRESH
          // per-turn thread, so the graph checkpointer only carries this turn's own
          // tool loop and an aborted turn can leave no dangling user message behind.
          messages: [...this.committedMessages, userMessage],
          screenKey,
          screenRegistry,
          screens: screens ?? [],
          guideContext,
        },
        {
          configurable: {
            thread_id: `${this.threadId}-${turnId}`,
            signal: this.turnAbort.signal,
            callbacks: {
              onTextDelta: (t: string) => {
                assistantText += t;
              },
              // The final assistant message (the loop only ends on __end__, so it
              // carries no pending tool_use). Captured for the committed history.
              onAssistantTurnComplete: (content: ContentBlock[]) => {
                finalAssistantContent = content;
              },
              onUiTool: (name: string, _id: string, input: Record<string, unknown>) =>
                // Returned so the graph can serialize the real outcome (e.g.
                // navigate's { ok, path }) into the tool_result.
                dispatchGuideUiTool(name, input, {
                  adapter: this.react.adapter,
                  capabilities: this.react.capabilities,
                  advanceDemo: this.react.advanceDemo,
                  startWalkthrough: this.react.startWalkthrough,
                }),
            },
          },
        },
      );
    } catch (err) {
      // spec-264 t-2 (dec-2): an interrupt (Stop) or a superseding turn aborts the
      // in-flight graph call. Drop that throw SILENTLY — the turn is abandoned, so we
      // must not flip to an error state; interrupt()/the new turn owns what's next.
      if (this.currentTurnId !== turnId) return;
      this.hooks.onError(err instanceof Error ? err.message : String(err));
      // spec-214 dec-1/dec-2: recover through beginListeningTurn so the internal
      // gate state (and a fresh STT session) follow the pill back to listening.
      this.beginListeningTurn();
      // spec-211 t-1: settle the turn even on error so an awaiting sequencer
      // (dec-1) never hangs.
      this.hooks.onTurnComplete?.();
      return;
    }

    // spec-264 t-2 (dec-2): a Stop (interrupt) or a superseding turn moved on while we
    // awaited the reply — abandon this turn entirely. Do NOT speak its answer and do
    // NOT commit it, so the next utterance is handled clean with no tail of this one.
    if (this.currentTurnId !== turnId || this.stopped) return;

    if (assistantText.trim()) {
      // The turn completed cleanly: commit user + assistant to the owned history so
      // the NEXT turn carries this exchange (completed prior turns are preserved).
      this.committedMessages.push(userMessage, {
        role: 'assistant',
        content: finalAssistantContent ?? [{ type: 'text', text: assistantText }],
      });
      const requestId = this.newId();
      this.speakingRequestId = requestId;
      // spec-214 dec-3: remember what we're about to say so the self-echo guard can
      // recognise this reply bleeding back into the mic after it plays out.
      this.lastSpokenTokens = new Set(tokenize(assistantText));
      // Re-base the playback turn (full gain + fresh played-ms clock).
      this.playback?.startTurn();
      // spec-214 dec-1: entering `speaking` closes the mic→STT gate — captured echo
      // is no longer forwarded upstream.
      this.enterState('speaking');
      this.ws?.speak(requestId, assistantText);
    } else {
      // No speech to play (empty). spec-214 dec-2: re-open the STT session for the
      // next human turn. spec-211 t-1: settle so an awaiting sequencer advances.
      this.beginListeningTurn();
      this.hooks.onTurnComplete?.();
    }
  }

  private onAudio(requestId: string, audio: ArrayBuffer, isFinal: boolean): void {
    // spec-264 t-2 (dec-2): drop audio from a turn we've moved on from. After a Stop
    // (interrupt nulls speakingRequestId) or a superseding turn (a new requestId), TTS
    // chunks the server had ALREADY sent for the old request keep arriving over the
    // WS — without this guard they enqueue and play out the tail of the abandoned
    // answer ("it finishes the previous sentence"). Only the current request plays.
    if (requestId !== this.speakingRequestId) return;
    void this.playback?.enqueue(audio);
    // isFinal marks the last chunk RECEIVED, but the audio is still playing out of
    // the queue. Stay in 'speaking' — the Stop control visible — until playback
    // actually drains, so the user can hit Stop for as long as they hear the agent.
    // onDrain fires immediately if nothing is queued.
    if (isFinal) this.playback?.onDrain(() => this.onPlaybackDrained());
  }

  /** The agent's speech has fully played out. Now — not on the final-chunk receipt
   *  — return to listening (opening a fresh STT session for the next human turn). */
  private onPlaybackDrained(): void {
    if (this.stopped) return;
    this.speakingRequestId = null;
    // spec-214 dec-3: mark when speaking ended so the self-echo guard's cooldown can
    // catch the speaker tail bleeding into the start of this listening window.
    this.speakingEndedAt = this.now();
    this.beginListeningTurn();
    // spec-211 t-1: the agent's spoken turn has fully played out — signal the
    // client tour sequencer so it can advance one phase (dec-1).
    this.hooks.onTurnComplete?.();
    // spec-222 t-4 (dec-8): flush any DEFERRED destructive navigation the adapter
    // queued during this turn (the website's staticSiteNavigation defers a
    // cross-page page-turn to here, so Specky finishes speaking before the reload).
    // The app's react-router adapter omits this hook → immediate soft-nav, unchanged.
    this.react.adapter.onPlaybackDrained?.();
  }

  // spec-214 dec-4: Stop is the SOLE interruption (voice barge-in removed). Halt the
  // in-flight LLM turn + TTS, flush queued audio, and return to listening with the
  // session + mic still open (halt-and-stay, NOT end-and-restart).
  interrupt(): void {
    if (this.stopped) return;
    // spec-264 t-2 (dec-2): abandon the in-flight turn. Clearing currentTurnId means
    // that when its graph.invoke resolves (or its abort throws) it neither speaks nor
    // commits to history — the partial/aborted turn is dropped ENTIRELY, so the next
    // utterance starts clean instead of the model resuming the interrupted answer.
    this.currentTurnId = null;
    this.turnAbort?.abort();
    if (this.speakingRequestId) {
      this.ws?.abort(this.speakingRequestId);
      this.speakingRequestId = null;
    }
    this.playback?.flush();
    this.speakingEndedAt = this.now();
    this.beginListeningTurn();
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
