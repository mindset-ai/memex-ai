// Deterministic ElevenLabs voice double used by tests and E2E. Activated when
// MEMEX_ELEVENLABS_FAKE=1 — resolveVoiceProvider() returns this instead of the
// real ElevenLabsVoiceProvider, so the WS voice route (t-1), the barge-in engine
// (t-2), and the graph wiring (t-3) can be exercised without a real key or live
// audio. Mirrors agent/anthropic-fake.ts: a module-level queue an out-of-process
// test runner (Playwright) can drive over HTTP via /api/__test__.
//
// STT: tests enqueue a transcript script; the next openStt() session replays it —
// interim events (isFinal:false) on each pushAudio (mid-utterance, ac-6), the
// final event on endUtterance().
// TTS: synthesize() derives audio + char-alignment deterministically from the
// text (one chunk per word, fabricated timestamps) so the round-trip and the
// alignment path (dec-8) are assertable; it honours the abort signal (barge-in).

import {
  AsyncChunkQueue,
  type SttOptions,
  type SttSession,
  type TranscriptEvent,
  type TtsAudioChunk,
  type TtsOptions,
  type VoiceProvider,
} from "./elevenlabs-client.js";

export interface FakeSttScript {
  /** Ordered transcript events. The terminal event SHOULD carry isFinal:true;
   *  interim events are replayed one-per-pushAudio, the final on endUtterance. */
  events: TranscriptEvent[];
}

const sttScripts: FakeSttScript[] = [];

/** Queue a transcript script for the NEXT openStt() session (FIFO). */
export function enqueueFakeTranscript(script: FakeSttScript): void {
  sttScripts.push(script);
}

/** Drop all queued STT scripts. */
export function clearFakeVoiceQueue(): void {
  sttScripts.length = 0;
}

/** How many STT scripts are queued (test assertions). */
export function peekFakeSttQueueLength(): number {
  return sttScripts.length;
}

class FakeSttSession implements SttSession {
  private readonly queue = new AsyncChunkQueue<TranscriptEvent>();
  private readonly interim: TranscriptEvent[];
  private readonly finalEvent: TranscriptEvent;
  private interimIdx = 0;
  private closed = false;

  constructor() {
    const script = sttScripts.shift();
    const events = script?.events ?? [
      { text: "hello", isFinal: false },
      { text: "hello there", isFinal: true },
    ];
    // Split into interim events (replayed on pushAudio) and the single final
    // event (emitted on endUtterance). If the script has no explicit final,
    // promote the last event to final so a turn always terminates.
    const finalIdx = events.findIndex((e) => e.isFinal);
    if (finalIdx === -1) {
      this.interim = events.slice(0, -1);
      const last = events[events.length - 1] ?? { text: "", isFinal: false };
      this.finalEvent = { ...last, isFinal: true };
    } else {
      this.interim = events.slice(0, finalIdx);
      this.finalEvent = events[finalIdx];
    }
  }

  pushAudio(_chunk: Uint8Array): void {
    if (this.closed) return;
    // An interim transcript lands while the user is still speaking (ac-6).
    if (this.interimIdx < this.interim.length) {
      this.queue.push(this.interim[this.interimIdx++]);
    }
  }

  endUtterance(): void {
    if (this.closed) return;
    // Flush any interim events not yet emitted (short utterance), then the final.
    while (this.interimIdx < this.interim.length) {
      this.queue.push(this.interim[this.interimIdx++]);
    }
    this.queue.push(this.finalEvent);
    this.queue.close();
  }

  transcripts(): AsyncIterable<TranscriptEvent> {
    return this.queue.drain();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.close();
  }
}

class FakeVoiceProvider implements VoiceProvider {
  readonly name = "elevenlabs-fake";
  readonly audioFormat = "pcm_16000";

  openStt(_opts?: SttOptions): SttSession {
    return new FakeSttSession();
  }

  async *synthesize(text: string, opts: TtsOptions = {}): AsyncIterable<TtsAudioChunk> {
    // One chunk per word, with deterministic fabricated alignment so the
    // round-trip + dec-8 truncation path are assertable. Playback can start on
    // chunk 0 before the final chunk arrives (ac-7).
    const words = text.split(/\s+/).filter(Boolean);
    let cursorMs = 0;
    for (let i = 0; i < words.length; i++) {
      if (opts.signal?.aborted) return; // barge-in cut (dec-8) — stop emitting
      const word = words[i] + (i < words.length - 1 ? " " : "");
      const chars = [...word];
      const charStartMs = chars.map((_, j) => cursorMs + j * 50);
      const charDurationMs = chars.map(() => 50);
      cursorMs += chars.length * 50;
      yield {
        // Audio bytes are opaque to the fake — encode the word so a test can
        // reconstruct what was "spoken".
        audio: new TextEncoder().encode(word),
        alignment: { chars, charStartMs, charDurationMs },
        isFinal: i === words.length - 1,
      };
    }
    // Empty text still yields a terminal (silent) chunk so callers see isFinal.
    if (words.length === 0) {
      yield { audio: new Uint8Array(), alignment: { chars: [], charStartMs: [], charDurationMs: [] }, isFinal: true };
    }
  }
}

export function createFakeVoiceProvider(): VoiceProvider {
  return new FakeVoiceProvider();
}
