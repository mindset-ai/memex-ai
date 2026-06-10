// spec-190 t-6 (dec-6) — integration tests for the voice guide's knowledge store
// and two-layer retrieval. Hits the real Postgres test DB (the guide_content
// table + generated tsvector + pgvector indexes from migration 0079). Uses a
// deterministic topic-based fake EmbeddingProvider so the vector arm is
// assertable without burning API tokens: each text embeds to a one-hot vector
// keyed on a topic token, so same-topic texts have cosine distance ~0 and
// different-topic texts ~1 (floored out by the relevance ceiling).
//
// Tags ac-13 (table shape + EmbeddingProvider write), ac-14 (route-change
// pre-fetch is a pure screen_key lookup — no embedding, no vector search), and
// ac-15 (per-turn embed + pgvector search with FTS fallback; search_guide is a
// secondary, non-load-bearing tool).

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import {
  upsertGuideChunk,
  prefetchScreenContent,
  searchGuideContent,
  pruneGuideContent,
  type GuideChunkInput,
} from "./guide-content.js";
import type { EmbeddingProvider } from "./embedding-provider.js";
import { GUIDE_TOOLS, GUIDE_TOOL_NAMES } from "@memex/shared";

const AC13 = "mindset-prod/memex-building-itself/specs/spec-190/acs/ac-13";
const AC14 = "mindset-prod/memex-building-itself/specs/spec-190/acs/ac-14";
const AC15 = "mindset-prod/memex-building-itself/specs/spec-190/acs/ac-15";
// Scope ac-10 (vector-search half): the guide answers from content retrieved by
// vector search WITHOUT leaving Postgres mid-conversation.
const AC10 = "mindset-prod/memex-building-itself/specs/spec-190/acs/ac-10";

// One-hot, topic-keyed fake provider. Same topic token in two texts → identical
// vector → cosine distance 0; different topics → orthogonal → distance 1 (> the
// 0.65 floor, so dropped). Lets us pin which chunk a query retrieves.
function makeTopicProvider(name = "fake-topic-1536"): EmbeddingProvider & {
  calls: Array<{ kind: "document" | "query"; texts: string[] }>;
} {
  const TOPICS = ["specs", "standards", "drift", "pulse"];
  function topicIndex(text: string): number {
    const lower = text.toLowerCase();
    for (let i = 0; i < TOPICS.length; i++) {
      if (lower.includes(TOPICS[i])) return i + 1; // 0 reserved for "no topic"
    }
    return 0;
  }
  const provider = {
    name,
    dim: 1536,
    maxBatchSize: 16,
    calls: [] as Array<{ kind: "document" | "query"; texts: string[] }>,
    async embed(texts: string[], kind: "document" | "query"): Promise<number[][]> {
      provider.calls.push({ kind, texts });
      return texts.map((t) => {
        const v = new Array(1536).fill(0);
        v[topicIndex(t)] = 1;
        return v;
      });
    },
  };
  return provider;
}

async function clearCorpus(): Promise<void> {
  await db.execute(sql`DELETE FROM guide_content`);
}

beforeEach(clearCorpus);
afterAll(clearCorpus);

function chunk(overrides: Partial<GuideChunkInput> = {}): GuideChunkInput {
  return {
    surface: "memex-app",
    screenKey: "specs-list",
    sourcePath: "screens/specs-list.md",
    chunkIndex: 0,
    heading: "The Specs board",
    contentHash: "h1",
    content: "The Specs board lists every active spec in this Memex.",
    ...overrides,
  };
}

interface RawRow {
  screen_key: string | null;
  source_path: string;
  chunk_index: number;
  heading: string | null;
  content_hash: string;
  content: string;
  embedding: string | null; // pgvector text form "[v1,...]"
  embedding_model: string | null;
  tsv_len: number;
}

async function readRow(sourcePath: string, chunkIndex: number): Promise<RawRow | null> {
  const rows = (await db.execute(sql`
    SELECT screen_key, source_path, chunk_index, heading, content_hash, content,
           embedding::text AS embedding, embedding_model,
           length(content_tsv::text) AS tsv_len
    FROM guide_content
    WHERE source_path = ${sourcePath} AND chunk_index = ${chunkIndex}
    LIMIT 1
  `)) as unknown as RawRow[];
  return rows[0] ?? null;
}

function vectorDim(encoded: string | null): number {
  if (!encoded) return 0;
  const inner = encoded.trim().replace(/^\[/, "").replace(/\]$/, "");
  return inner.length === 0 ? 0 : inner.split(",").length;
}

describe("guide_content table + EmbeddingProvider write (ac-13)", () => {
  it("stores the chunk's columns and writes a 1536-dim embedding through the provider", async () => {
    tagAc(AC13);
    const provider = makeTopicProvider();
    const res = await upsertGuideChunk(chunk(), { provider });

    expect(res.status).toBe("embedded");
    expect(res.model).toBe(provider.name);
    // The vector was produced by the EmbeddingProvider (document side).
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].kind).toBe("document");

    const row = await readRow("screens/specs-list.md", 0);
    expect(row).not.toBeNull();
    expect(row!.screen_key).toBe("specs-list");
    expect(row!.content_hash).toBe("h1");
    expect(row!.heading).toBe("The Specs board");
    expect(row!.embedding_model).toBe(provider.name);
    expect(vectorDim(row!.embedding)).toBe(1536);
    // Generated FTS column is populated by Postgres on write.
    expect(row!.tsv_len).toBeGreaterThan(0);
  });

  it("reuses an unchanged chunk without re-embedding (idempotent import)", async () => {
    tagAc(AC13);
    const provider = makeTopicProvider();
    await upsertGuideChunk(chunk({ contentHash: "h1" }), { provider });
    expect(provider.calls).toHaveLength(1);

    // Same hash + same provider → no re-embed.
    const again = await upsertGuideChunk(chunk({ contentHash: "h1" }), { provider });
    expect(again.status).toBe("reused");
    expect(provider.calls).toHaveLength(1); // unchanged — no second embed

    // Hash change → re-embed.
    const changed = await upsertGuideChunk(
      chunk({ contentHash: "h2", content: "Updated specs board copy." }),
      { provider },
    );
    expect(changed.status).toBe("embedded");
    expect(provider.calls).toHaveLength(2);
  });

  it("upserts without a vector in degraded mode (no provider) — FTS still covers", async () => {
    tagAc(AC13);
    const res = await upsertGuideChunk(chunk(), { provider: null });
    expect(res.status).toBe("skipped-no-provider");
    const row = await readRow("screens/specs-list.md", 0);
    expect(row).not.toBeNull();
    expect(row!.embedding).toBeNull();
    expect(row!.tsv_len).toBeGreaterThan(0); // FTS still works
  });
});

describe("Layer 1 — route-change screen pre-fetch (ac-14)", () => {
  it("returns the screen's chunks by a deterministic screen_key lookup with no provider involved", async () => {
    tagAc(AC14);
    // Insert in degraded mode (no provider) so the rows carry NO embedding — proving
    // the pre-fetch path can't be relying on a vector search.
    await upsertGuideChunk(
      chunk({ chunkIndex: 0, contentHash: "a", content: "Specs board chunk one." }),
      { provider: null },
    );
    await upsertGuideChunk(
      chunk({ chunkIndex: 1, contentHash: "b", content: "Specs board chunk two." }),
      { provider: null },
    );
    // A different screen — must be excluded.
    await upsertGuideChunk(
      chunk({
        screenKey: "standards-list",
        sourcePath: "screens/standards-list.md",
        chunkIndex: 0,
        contentHash: "c",
        content: "Standards list chunk.",
      }),
      { provider: null },
    );
    // A concept chunk (screen_key NULL) — search-only, must be excluded.
    await upsertGuideChunk(
      chunk({
        screenKey: null,
        sourcePath: "concepts/overview.md",
        chunkIndex: 0,
        contentHash: "d",
        content: "Concept overview chunk.",
      }),
      { provider: null },
    );

    const got = await prefetchScreenContent("specs-list", "memex-app");
    expect(got).toEqual(["Specs board chunk one.", "Specs board chunk two."]);
  });

  it("returns [] for an unknown or null screen key without touching a provider", async () => {
    tagAc(AC14);
    expect(await prefetchScreenContent("no-such-screen", "memex-app")).toEqual([]);
    expect(await prefetchScreenContent(null, "memex-app")).toEqual([]);
  });
});

describe("Layer 2 — per-turn vector search with FTS fallback (ac-15)", () => {
  it("embeds the utterance and returns vector hits over the whole corpus, floored by relevance", async () => {
    tagAc(AC15);
    tagAc(AC10); // scope: in-Postgres vector retrieval of up-to-date guide content

    const provider = makeTopicProvider();
    // Two topics in the corpus, on DIFFERENT screens (whole-corpus search).
    await upsertGuideChunk(
      chunk({
        screenKey: "specs-list",
        sourcePath: "screens/specs-list.md",
        chunkIndex: 0,
        contentHash: "a",
        content: "How the Specs board works and how to open a spec.",
      }),
      { provider },
    );
    await upsertGuideChunk(
      chunk({
        screenKey: "standards-list",
        sourcePath: "screens/standards-list.md",
        chunkIndex: 0,
        contentHash: "b",
        content: "How Standards define the rules of the Memex.",
      }),
      { provider },
    );

    const hits = await searchGuideContent("tell me about specs", { surface: "memex-app", provider });
    // The query embeds on the QUERY side...
    expect(provider.calls.some((c) => c.kind === "query")).toBe(true);
    // ...and the specs chunk is retrieved by vector; the standards chunk is
    // orthogonal (distance ~1 > 0.65 floor) and dropped.
    expect(hits.length).toBe(1);
    expect(hits[0].method).toBe("vector");
    expect(hits[0].sourcePath).toBe("screens/specs-list.md");
    expect(hits[0].distance).toBeLessThan(0.65);
  });

  it("falls back to FTS when embeddings are absent (rows imported without a provider)", async () => {
    tagAc(AC15);
    // Corpus has NO vectors (degraded import). Even with a provider at query
    // time, the vector arm finds nothing → FTS fallback answers.
    await upsertGuideChunk(
      chunk({
        sourcePath: "concepts/drift.md",
        screenKey: null,
        chunkIndex: 0,
        contentHash: "a",
        content: "Drift is when a spec and its code disagree.",
      }),
      { provider: null },
    );
    const provider = makeTopicProvider();
    const hits = await searchGuideContent("what is drift", { surface: "memex-app", provider });
    expect(hits.length).toBe(1);
    expect(hits[0].method).toBe("fts");
    expect(hits[0].sourcePath).toBe("concepts/drift.md");
  });

  it("uses FTS directly when no provider is configured at all", async () => {
    tagAc(AC15);
    await upsertGuideChunk(
      chunk({ content: "Specs board overview text.", contentHash: "a" }),
      { provider: null },
    );
    const hits = await searchGuideContent("specs board", { surface: "memex-app", provider: null });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.method === "fts")).toBe(true);
  });

  it("returns [] for an empty query without embedding or searching", async () => {
    tagAc(AC15);
    const provider = makeTopicProvider();
    expect(await searchGuideContent("   ", { surface: "memex-app", provider })).toEqual([]);
    expect(provider.calls).toHaveLength(0);
  });

  it("exposes search_guide as a secondary tool, but Layer-2 retrieval runs independently of it", async () => {
    tagAc(AC15);
    // The tool exists in the canonical toolset (so the agent CAN deliberately
    // search)...
    expect(GUIDE_TOOL_NAMES.has("search_guide")).toBe(true);
    expect(GUIDE_TOOLS.some((t) => t.name === "search_guide")).toBe(true);
    // ...but answering does not DEPEND on it: searchGuideContent is a plain
    // function the per-turn path calls directly, with no tool-dispatch in the loop.
    const provider = makeTopicProvider();
    await upsertGuideChunk(
      chunk({ content: "Specs board explainer.", contentHash: "a" }),
      { provider },
    );
    const hits = await searchGuideContent("specs", { surface: "memex-app", provider });
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe("pruneGuideContent (orphan removal helper for the t-7 importer)", () => {
  it("deletes rows whose source file is not in the keep set", async () => {
    const provider = makeTopicProvider();
    await upsertGuideChunk(
      chunk({ sourcePath: "screens/specs-list.md", contentHash: "a" }),
      { provider },
    );
    await upsertGuideChunk(
      chunk({
        sourcePath: "screens/gone.md",
        screenKey: "specs-list",
        contentHash: "b",
        content: "Removed file.",
      }),
      { provider },
    );
    const deleted = await pruneGuideContent("memex-app", ["screens/specs-list.md"]);
    expect(deleted).toBe(1);
    expect(await readRow("screens/gone.md", 0)).toBeNull();
    expect(await readRow("screens/specs-list.md", 0)).not.toBeNull();
  });
});
