import Anthropic from "@anthropic-ai/sdk";
import { createFakeAnthropicClient } from "./anthropic-fake.js";

// Centralises Anthropic SDK construction so callers never instantiate the client at module
// load (which used to propagate an unhelpful SDK auth error to the UI when ANTHROPIC_API_KEY
// was missing). The client is built lazily on first use and a typed error surfaces a clear
// 503 to the admin.

export class LlmNotConfiguredError extends Error {
  constructor() {
    super(
      "ANTHROPIC_API_KEY is not set. LLM features (chat, create-doc, task-prompt generation) are unavailable. " +
        "Set ANTHROPIC_API_KEY in packages/server/.env and restart the server."
    );
    this.name = "LlmNotConfiguredError";
  }
}

let cached: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (cached) return cached;
  // E2E hook: when MEMEX_ANTHROPIC_FAKE=1 the process uses a deterministic in-memory double
  // instead of the real SDK. Tests queue canned responses via /api/__test__/anthropic-queue.
  if (process.env.MEMEX_ANTHROPIC_FAKE === "1") {
    cached = createFakeAnthropicClient() as unknown as Anthropic;
    return cached;
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new LlmNotConfiguredError();
  cached = new Anthropic({ apiKey: key, fetch: makeSafeFetch() });
  return cached;
}

// Wraps the global fetch so that iterating response.headers (used by the Anthropic SDK only
// for request-id logging) doesn't throw "cookies is not iterable". This happens when the
// runtime Node binary (e.g. Zed's embedded Node v24) bundles an undici version whose
// headers iterator walks a null `cookies` list via for...of. The proxy intercepts
// entries() / Symbol.iterator and absorbs per-next() throws, yielding whatever entries
// it could read before the error. All other Response access passes through to target
// (NOT via Reflect.get with a proxy receiver, which breaks private-field accessors).
function makeSafeFetch(): typeof globalThis.fetch {
  return async function safeFetch(
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1]
  ): Promise<Response> {
    const response = await globalThis.fetch(input, init);
    return wrapResponseWithSafeHeaders(response);
  };
}

function wrapResponseWithSafeHeaders(response: Response): Response {
  const headersProxy = new Proxy(response.headers, {
    get(target, prop) {
      if (prop === "entries" || prop === Symbol.iterator) {
        return function* safeEntries() {
          const iter = target.entries();
          while (true) {
            let result: IteratorResult<[string, string]>;
            try {
              result = iter.next();
            } catch (e) {
              console.warn(
                "[anthropic-fetch] headers.entries() failed, falling back:",
                (e as Error).message
              );
              break;
            }
            if (result.done) break;
            yield result.value;
          }
        };
      }
      const val = target[prop as keyof typeof target];
      return typeof val === "function" ? (val as (...a: unknown[]) => unknown).bind(target) : val;
    },
  });

  return new Proxy(response, {
    get(target, prop) {
      if (prop === "headers") return headersProxy;
      const val = target[prop as keyof typeof target];
      return typeof val === "function" ? (val as (...a: unknown[]) => unknown).bind(target) : val;
    },
  });
}

// Surfaces at server startup so operators see the misconfiguration immediately rather than
// discovering it on first LLM call. Idempotent; safe to call more than once.
export function warnIfLlmNotConfigured(): void {
  if (process.env.ANTHROPIC_API_KEY) return;
  console.warn(
    "\n⚠️  ANTHROPIC_API_KEY is not set — LLM routes (/api/llm/*) will return 503.\n" +
      "   Copy packages/server/.env.example → .env and fill in ANTHROPIC_API_KEY to enable.\n"
  );
}
