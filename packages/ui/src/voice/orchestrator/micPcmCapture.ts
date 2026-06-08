// spec-190 t-3 — capture 16 kHz mono PCM16 frames from the (AEC'd) mic stream to
// send upstream to the server STT (Scribe v2 Realtime wants pcm_16000). This is
// browser device-glue — validated on a real device, not in jsdom — so it lives
// behind a tiny interface the orchestrator injects (a fake feeds frames in tests).
//
// Uses a ScriptProcessorNode: deprecated but needs NO bundled worklet asset, and
// the VAD already owns the only AudioWorklet we ship (Silero). Downsamples the
// context rate (usually 48 kHz) to 16 kHz by linear resampling and converts
// Float32 [-1,1] → Int16.

export interface PcmCapture {
  start(stream: MediaStream, onFrame: (pcm: ArrayBuffer) => void): Promise<void> | void;
  stop(): void;
}

const TARGET_RATE = 16000;

export class WebAudioPcmCapture implements PcmCapture {
  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;

  start(stream: MediaStream, onFrame: (pcm: ArrayBuffer) => void): void {
    const ctx = new AudioContext();
    this.ctx = ctx;
    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    const ratio = ctx.sampleRate / TARGET_RATE;

    processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const outLen = Math.floor(input.length / ratio);
      const pcm = new Int16Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const sample = input[Math.floor(i * ratio)];
        const clamped = Math.max(-1, Math.min(1, sample));
        pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      }
      onFrame(pcm.buffer);
    };

    source.connect(processor);
    // ScriptProcessor only fires while connected to the graph; route to a muted
    // sink so it ticks without echoing the mic to the speakers.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    processor.connect(sink).connect(ctx.destination);

    this.source = source;
    this.processor = processor;
  }

  stop(): void {
    try {
      if (this.processor) this.processor.onaudioprocess = null;
      this.processor?.disconnect();
      this.source?.disconnect();
      void this.ctx?.close();
    } finally {
      this.processor = null;
      this.source = null;
      this.ctx = null;
    }
  }
}

export const makePcmCapture = (): PcmCapture => new WebAudioPcmCapture();
