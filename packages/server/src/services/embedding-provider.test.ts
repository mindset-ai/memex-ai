// spec-522 t-3 (dec-2) — first coverage for resolveEmbeddingProvider().
//
// Two jobs here:
//   1. Pin the RESOLUTION CONTRACT that predates the memo (disabled → null,
//      "none" → null, explicit-but-keyless → null, unknown → throws every call,
//      auto-pick OpenAI before Cohere). Nothing tested this before; the memo is
//      only safe to add if these are nailed down.
//   2. Pin the MEMO itself: same env → same instance (ac-13, so the SDK client
//      and its connection pool are reused across requests), changed env → fresh
//      instance (ac-14, so the memo can never serve a stale provider).
//
// PURE UNIT TEST — no DB, no network. Neither SDK constructor performs I/O, so
// a fake API key is enough to exercise construction.
//
// Every test saves and restores process.env [per std-37]: vitest runs with
// fileParallelism: true and test FILES SHARE A WORKER PROCESS, so leaking an
// EMBEDDING_* var out of this file would poison whichever file the worker picks
// up next (routes/search.integration.test.ts is env-sensitive by design).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { resolveEmbeddingProvider } from "./embedding-provider.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-522/acs/ac-${n}`;

const OPENAI_NAME = "openai-text-embedding-3-large-1536";
const COHERE_NAME = "cohere-embed-v4-1536";

const saved = { ...process.env };

// The four vars the memo is keyed on. Cleared before each test so no ambient
// developer .env (a real OPENAI_API_KEY, say) changes what these assert.
const EMBEDDING_VARS = [
  "EMBEDDING_DISABLED",
  "EMBEDDING_PROVIDER",
  "OPENAI_API_KEY",
  "COHERE_API_KEY",
] as const;

// Worker- and test-unique key values. Because the memo is keyed on the resolved
// env tuple, a unique key per test is what gives each test a clean memo — no
// exported reset hatch needed (and none exists, deliberately; see the service).
let n = 0;
const uniqueKey = (label: string) =>
  `test-${label}-w${process.env.VITEST_POOL_ID ?? "0"}-${n++}`;

beforeEach(() => {
  for (const v of EMBEDDING_VARS) delete process.env[v];
});

afterEach(() => {
  // Full restore, not just the four vars: cheap, and it can't drift if someone
  // later sets a fifth var in a test.
  for (const k of Object.keys(process.env)) {
    if (!(k in saved)) delete process.env[k];
  }
  Object.assign(process.env, saved);
});

describe("resolveEmbeddingProvider — resolution order", () => {
  it("EMBEDDING_DISABLED=1 wins over a present key, and is read at CALL time", () => {
    process.env.OPENAI_API_KEY = uniqueKey("disabled");
    expect(resolveEmbeddingProvider()?.name).toBe(OPENAI_NAME);

    // Same process, same import — the flag must still take effect, which it
    // only can if env is read per call rather than latched at module load.
    process.env.EMBEDDING_DISABLED = "1";
    expect(resolveEmbeddingProvider()).toBeNull();
  });

  it("EMBEDDING_PROVIDER=none returns null even with keys present", () => {
    process.env.EMBEDDING_PROVIDER = "none";
    process.env.OPENAI_API_KEY = uniqueKey("none-openai");
    process.env.COHERE_API_KEY = uniqueKey("none-cohere");
    expect(resolveEmbeddingProvider()).toBeNull();
  });

  it("an explicitly named provider with no key returns null (degraded, not throw)", () => {
    process.env.EMBEDDING_PROVIDER = "openai";
    expect(resolveEmbeddingProvider()).toBeNull();

    process.env.EMBEDDING_PROVIDER = "cohere";
    expect(resolveEmbeddingProvider()).toBeNull();
  });

  it("EMBEDDING_PROVIDER=cohere uses Cohere even when an OpenAI key is present", () => {
    process.env.EMBEDDING_PROVIDER = "cohere";
    process.env.COHERE_API_KEY = uniqueKey("explicit-cohere");
    process.env.OPENAI_API_KEY = uniqueKey("ignored-openai");
    expect(resolveEmbeddingProvider()?.name).toBe(COHERE_NAME);
  });

  it("auto-picks OpenAI first, then falls through to Cohere", () => {
    process.env.OPENAI_API_KEY = uniqueKey("auto-openai");
    process.env.COHERE_API_KEY = uniqueKey("auto-cohere");
    expect(resolveEmbeddingProvider()?.name).toBe(OPENAI_NAME);

    delete process.env.OPENAI_API_KEY;
    expect(resolveEmbeddingProvider()?.name).toBe(COHERE_NAME);
  });

  it("no keys and no explicit provider returns null (degraded mode)", () => {
    expect(resolveEmbeddingProvider()).toBeNull();
  });

  it("an unknown EMBEDDING_PROVIDER throws on EVERY call — the throw is not memoised", () => {
    process.env.EMBEDDING_PROVIDER = "x";
    const msg =
      "Unknown EMBEDDING_PROVIDER='x'. Supported: openai, cohere, none.";
    expect(() => resolveEmbeddingProvider()).toThrow(msg);
    // Not a one-shot: a misconfiguration must keep surfacing, and correcting
    // the env must recover with no cache to clear.
    expect(() => resolveEmbeddingProvider()).toThrow(msg);

    process.env.EMBEDDING_PROVIDER = "none";
    expect(resolveEmbeddingProvider()).toBeNull();
  });

  it("a throwing resolution does not clobber the memo held for another env", () => {
    process.env.OPENAI_API_KEY = uniqueKey("survives-throw");
    const before = resolveEmbeddingProvider();

    process.env.EMBEDDING_PROVIDER = "bogus";
    expect(() => resolveEmbeddingProvider()).toThrow(/Unknown EMBEDDING_PROVIDER/);

    // Reverting the env re-hits the memo entry that was already there.
    delete process.env.EMBEDDING_PROVIDER;
    expect(resolveEmbeddingProvider()).toBe(before);
  });
});

describe("resolveEmbeddingProvider — memoisation (spec-522 dec-2)", () => {
  it("returns the SAME instance across repeated calls while the env is unchanged", () => {
    tagAc(AC(13));
    process.env.OPENAI_API_KEY = uniqueKey("memo-openai");

    const a = resolveEmbeddingProvider();
    const b = resolveEmbeddingProvider();
    const c = resolveEmbeddingProvider();

    expect(a).not.toBeNull();
    expect(a?.name).toBe(OPENAI_NAME);
    // Reference identity is the whole point: one SDK client, one HTTP agent,
    // so keep-alive connections and TLS sessions survive between requests.
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("memoises the Cohere arm and the null (degraded) result too", () => {
    tagAc(AC(13));
    process.env.EMBEDDING_PROVIDER = "cohere";
    process.env.COHERE_API_KEY = uniqueKey("memo-cohere");
    const a = resolveEmbeddingProvider();
    expect(a?.name).toBe(COHERE_NAME);
    expect(resolveEmbeddingProvider()).toBe(a);

    // null is a resolved value, not a cache miss — it must not re-run
    // resolution forever, and it must still be replaced when env changes.
    process.env.EMBEDDING_PROVIDER = "none";
    expect(resolveEmbeddingProvider()).toBeNull();
    expect(resolveEmbeddingProvider()).toBeNull();
  });

  it("changing OPENAI_API_KEY (rotation) yields a freshly built provider", () => {
    tagAc(AC(14));
    process.env.OPENAI_API_KEY = uniqueKey("rotate-a");
    const first = resolveEmbeddingProvider();

    process.env.OPENAI_API_KEY = uniqueKey("rotate-b");
    const second = resolveEmbeddingProvider();

    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(second?.name).toBe(OPENAI_NAME);
  });

  it("changing EMBEDDING_PROVIDER yields the other provider, not the stale memo", () => {
    tagAc(AC(14));
    process.env.OPENAI_API_KEY = uniqueKey("switch-openai");
    process.env.COHERE_API_KEY = uniqueKey("switch-cohere");
    const openai = resolveEmbeddingProvider();
    expect(openai?.name).toBe(OPENAI_NAME);

    process.env.EMBEDDING_PROVIDER = "cohere";
    const cohere = resolveEmbeddingProvider();
    expect(cohere?.name).toBe(COHERE_NAME);
    expect(cohere).not.toBe(openai);

    // …and back again: the memo holds ONE entry, so this is a rebuild, not a
    // second cache hit. Identity is not asserted — only correctness is.
    delete process.env.EMBEDDING_PROVIDER;
    expect(resolveEmbeddingProvider()?.name).toBe(OPENAI_NAME);
  });

  it("setting EMBEDDING_DISABLED after a provider is memoised returns null, and clearing it rebuilds", () => {
    tagAc(AC(14));
    process.env.OPENAI_API_KEY = uniqueKey("disable-cycle");
    const live = resolveEmbeddingProvider();
    expect(live?.name).toBe(OPENAI_NAME);

    // The trap a bare module-level singleton would fall into: an earlier caller
    // (or an earlier TEST FILE sharing this worker) has already warmed the memo
    // when EMBEDDING_DISABLED arrives [per std-37].
    process.env.EMBEDDING_DISABLED = "1";
    expect(resolveEmbeddingProvider()).toBeNull();

    delete process.env.EMBEDDING_DISABLED;
    expect(resolveEmbeddingProvider()?.name).toBe(OPENAI_NAME);
  });

  it("adding COHERE_API_KEY resolves afresh when it changes the outcome", () => {
    tagAc(AC(14));
    // No keys at all → null, and that null gets memoised.
    expect(resolveEmbeddingProvider()).toBeNull();

    process.env.COHERE_API_KEY = uniqueKey("late-cohere");
    expect(resolveEmbeddingProvider()?.name).toBe(COHERE_NAME);
  });
});
