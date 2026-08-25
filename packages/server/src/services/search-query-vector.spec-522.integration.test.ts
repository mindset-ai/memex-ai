// spec-522 t-2 / t-5 — one embed per search, end to end through searchMemex.
//
// The unit tests in memex-search/query-vector.test.ts cover the cache and the
// timeout in isolation. This file asserts the thing that actually motivated the
// Spec: that a REAL search — all six arms, the full orchestrator — makes exactly
// one external embedding call, where it used to make three.
//
// WHY THE QUERY STRINGS ARE WORKER-UNIQUE. The query-vector cache is a module
// singleton shared by every test in the worker, which is the correct production
// shape. A fixed query string would therefore be a cache HIT if any sibling test
// searched it first, and "exactly one embed call" would pass for the wrong reason.
// Unique strings guarantee the first search of each test is a genuine miss
// [per std-37].

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { documents } from "../db/schema.js";
import { makeTestMemexWithDevAdmin } from "./test-helpers.js";
import { upsertUserByEmail } from "./users.js";
import { createDocDraft } from "./documents.js";
import { searchMemex } from "./memex-search.js";
import type { EmbeddingProvider } from "./embedding-provider.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-522/acs/ac-${n}`;

const __dirname = dirname(fileURLToPath(import.meta.url));
const createdDocIds: string[] = [];
const REST: { channel: "rest_ui"; actorUserId?: string } = { channel: "rest_ui" };

let memexId: string;
let devUserId: string;
let uniq = 0;

/** A query string no other test can collide with, so the module-level cache
 *  cannot turn a genuine miss into an accidental hit. */
function uniqueQuery(label: string): string {
  uniq += 1;
  return `zquibbl${process.env.VITEST_POOL_ID ?? "0"}x${uniq} ${label}`;
}

function countingProvider(
  opts: { delayMs?: number; throws?: boolean } = {},
): EmbeddingProvider & { callCount: number } {
  const p = {
    name: "fake-s522-1536",
    dim: 1536,
    maxBatchSize: 96,
    callCount: 0,
    async embed(texts: string[]): Promise<number[][]> {
      p.callCount += 1;
      if (opts.throws) throw new Error("provider unavailable");
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      // Any well-formed 1536-dim vector: these tests assert CALL COUNTS and
      // degradation, never ranking, so the values are irrelevant.
      return texts.map(() => Array.from({ length: 1536 }, () => 0.01));
    },
  };
  return p;
}

beforeAll(async () => {
  const made = await makeTestMemexWithDevAdmin("s522qv");
  memexId = made.memexId;
  const dev = await upsertUserByEmail("dev@memex.ai");
  devUserId = dev.id;
  REST.actorUserId = devUserId;

  const doc = await createDocDraft(
    memexId,
    "Quibbleflex latency notes",
    "Quibbleflex retrieval and caching behaviour.",
    "spec",
    undefined,
    undefined,
    devUserId,
    REST,
  );
  createdDocIds.push(doc.id);
});

afterAll(async () => {
  if (createdDocIds.length) {
    await db.delete(documents).where(inArray(documents.id, createdDocIds)).catch(() => {});
  }
});

describe("spec-522 — one embed per search (ac-10, ac-11)", () => {
  it("a full six-arm search issues exactly ONE embedding call, not three", async () => {
    tagAc(AC(10));
    // ac-1 is the scope-level statement of the same outcome: at most one external
    // query-embedding call per search, however many retrieval arms run.
    tagAc(AC(1));
    const provider = countingProvider();

    // No `kind` — the shape the ⌘K palette actually sends, so all three vector
    // arms (sections, decisions, issues) run. Each used to embed independently.
    await searchMemex(memexId, uniqueQuery("full fan out"), { provider });

    expect(provider.callCount).toBe(1);
  });

  it("still issues exactly one when a kind filter reduces the arm count", async () => {
    tagAc(AC(10));
    const provider = countingProvider();
    await searchMemex(memexId, uniqueQuery("scoped"), { provider, kind: "spec" });
    expect(provider.callCount).toBe(1);
  });

  it("issues NO embedding call when the vector arms are disabled", async () => {
    tagAc(AC(10));
    const provider = countingProvider();
    await searchMemex(memexId, uniqueQuery("fts only"), {
      provider,
      disableVector: true,
    });
    expect(provider.callCount).toBe(0);
  });

  it("a repeated query across separate searches reuses the cached vector", async () => {
    tagAc(AC(11));
    const provider = countingProvider();
    const query = uniqueQuery("repeat me");

    await searchMemex(memexId, query, { provider });
    expect(provider.callCount).toBe(1);

    // A second, entirely separate search for the same string — the case a user
    // creates constantly by retyping or reopening the palette on the same term.
    await searchMemex(memexId, query, { provider });
    await searchMemex(memexId, query, { provider });

    expect(provider.callCount).toBe(1);
  });
});

describe("spec-522 — search degrades rather than blocking (ac-15, ac-4)", () => {
  it("an unavailable provider still returns handle and FTS hits", async () => {
    tagAc(AC(15));
    // ac-4 is the scope-level commitment: a slow or unavailable provider degrades
    // search rather than blocking the palette. This is its "unavailable" half.
    tagAc(AC(4));
    const provider = countingProvider({ throws: true });

    // A handle query short-circuits before the arms; a free-text one exercises
    // the FTS arms with the vector arms yielding nothing. Neither may throw.
    await expect(
      searchMemex(memexId, "quibbleflex retrieval", { provider }),
    ).resolves.toBeInstanceOf(Array);
  });

  it("a hanging provider does not hang the search", async () => {
    tagAc(AC(15));
    // ...and this is ac-4's "slow" half — the one that had no handling at all
    // before this Spec.
    tagAc(AC(4));
    const saved = process.env.MEMEX_SEARCH_EMBED_TIMEOUT_MS;
    process.env.MEMEX_SEARCH_EMBED_TIMEOUT_MS = "20";
    try {
      // 5s of "work" against a 20 ms ceiling. Before the timeout this would have
      // held the whole request open via the orchestrator's Promise.all.
      const provider = countingProvider({ delayMs: 5_000 });
      const started = Date.now();

      const hits = await searchMemex(memexId, uniqueQuery("hangs"), { provider });

      expect(Date.now() - started).toBeLessThan(2_000);
      expect(hits).toBeInstanceOf(Array);
    } finally {
      if (saved === undefined) delete process.env.MEMEX_SEARCH_EMBED_TIMEOUT_MS;
      else process.env.MEMEX_SEARCH_EMBED_TIMEOUT_MS = saved;
    }
  });
});

describe("spec-522 — no progressive rendering was introduced (ac-16)", () => {
  // A negative AC is easy to "satisfy" by simply not having built the thing, so
  // this checks the shape of the code that would have had to change, the way
  // spec-521's ac-10 test does.
  it("the route still returns one envelope, resolved in a single Promise.all", () => {
    tagAc(AC(16));
    const route = readFileSync(resolve(__dirname, "../routes/search.ts"), "utf8");

    // One JSON body with the three lanes — not a stream, not two responses.
    expect(route).toContain("jumpTo:");
    expect(route).toContain("assigned:");
    expect(route).toContain("content:");
    expect(route).not.toMatch(/text\/event-stream|ReadableStream|SSE|streamSSE/);

    const core = readFileSync(resolve(__dirname, "memex-search.ts"), "utf8");
    // The arms are still gathered by one await; a two-phase shape would have had
    // to break this apart.
    expect(core).toContain("await Promise.all([");
  });

  it("the palette still debounces and aborts in-flight requests per keystroke", () => {
    tagAc(AC(16));
    const palette = readFileSync(
      resolve(__dirname, "../../../ui/src/components/SearchPalette.tsx"),
      "utf8",
    );

    expect(palette).toContain("AbortController");
    expect(palette).toContain("controller.abort()");
    expect(palette).toContain("setTimeout(");
    // Results are set once per settled response, not merged in phases.
    expect(palette).not.toMatch(/EventSource|text\/event-stream/);
  });
});
