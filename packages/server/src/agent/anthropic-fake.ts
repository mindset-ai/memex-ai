// Deterministic Anthropic SDK double used by E2E tests. Activated when
// MEMEX_ANTHROPIC_FAKE=1 is set on the server process — `getAnthropicClient()` returns
// an instance of this module's fake instead of a real `Anthropic` client.
//
// Tests push canned responses onto the queue via the /api/__test__/anthropic-queue
// endpoint before triggering a chat request. Each call to `messages.stream(...)` drains
// one queued response and emits its text deltas through the `.on("text", cb)` listener
// pattern that llm.ts uses, then resolves `.finalMessage()` with the canned content blocks.
//
// This mirrors the controllable-stream pattern from llm.streaming.test.ts but lives in a
// module-level queue so an out-of-process test runner (Playwright) can drive it via HTTP.

export type FakeContentBlock =
  | { type: "text"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    };

export type FakeStopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence";

export interface QueuedFakeResponse {
  textDeltas: string[];
  content: FakeContentBlock[];
  stopReason: FakeStopReason;
  // Optional millisecond delay between each text delta. Defaults to a small value so the
  // SSE stream visibly flushes per-delta (matches real-world streaming behaviour).
  deltaDelayMs?: number;
}

const queue: QueuedFakeResponse[] = [];

export function enqueueFakeResponse(response: QueuedFakeResponse): void {
  queue.push(response);
}

export function clearFakeQueue(): void {
  queue.length = 0;
}

export function peekFakeQueueLength(): number {
  return queue.length;
}

// Minimal surface of Anthropic's MessageStream that llm.ts relies on:
//   - `.on("text", cb)` to observe text deltas
//   - `.finalMessage()` promise that resolves with { content, stop_reason }
class FakeMessageStream {
  private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  private resolveFinal!: (msg: unknown) => void;
  private rejectFinal!: (err: unknown) => void;
  private finalPromise: Promise<unknown>;

  constructor(private response: QueuedFakeResponse) {
    this.finalPromise = new Promise((resolve, reject) => {
      this.resolveFinal = resolve;
      this.rejectFinal = reject;
    });
    // Kick off emission on the next microtask so the caller has a chance to register
    // listeners via `.on(...)` before text events fire.
    queueMicrotask(() => this.drive());
  }

  on(event: string, cb: (...args: unknown[]) => void): this {
    (this.listeners[event] ??= []).push(cb);
    return this;
  }

  finalMessage(): Promise<unknown> {
    return this.finalPromise;
  }

  private async drive(): Promise<void> {
    try {
      const delay = this.response.deltaDelayMs ?? 10;
      for (const delta of this.response.textDeltas) {
        for (const cb of this.listeners.text ?? []) cb(delta);
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      }
      this.resolveFinal({
        content: this.response.content,
        stop_reason: this.response.stopReason,
      });
    } catch (err) {
      this.rejectFinal(err);
    }
  }
}

// Shape intentionally loose — the real SDK's `Anthropic` class has a lot of surface area
// that llm.ts doesn't touch. Callers cast to `Anthropic` at the boundary.
export function createFakeAnthropicClient(): {
  messages: { stream: (opts: unknown) => FakeMessageStream };
} {
  return {
    messages: {
      stream: (_opts: unknown) => {
        const next = queue.shift();
        if (!next) {
          // Fall back to a harmless canned response so chat doesn't hang if a test forgot
          // to enqueue. Tests that care about exact content should assert queue length.
          return new FakeMessageStream({
            textDeltas: ["(fake-agent: no response queued)"],
            content: [
              { type: "text", text: "(fake-agent: no response queued)" },
            ],
            stopReason: "end_turn",
          });
        }
        return new FakeMessageStream(next);
      },
    },
  };
}
