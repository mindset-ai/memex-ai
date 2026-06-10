// spec-222 t-7 (dec-3) — integration tests for the voice-guide corpus's
// SURFACE isolation boundary. The guide_content corpus is shared, but a public
// website session must retrieve ONLY website content and an app session ONLY app
// content (ac-4 / ac-11 / ac-12). The server ENFORCES the filter; the client
// cannot widen it. These tests seed chunks under BOTH surfaces in the real
// Postgres test DB and assert retrieval never crosses the line.
//
// A deterministic topic-keyed fake EmbeddingProvider (one-hot vectors) makes the
// vector arm assertable: SAME query text on BOTH surfaces would otherwise match
// both — the only thing keeping them apart is the server-side surface filter, so
// these tests prove isolation, not just "different content lands in different
// rows".

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import {
  upsertGuideChunk,
  prefetchScreenContent,
  searchGuideContent,
  UnknownGuideSurfaceError,
  type GuideChunkInput,
} from "./guide-content.js";
import type { EmbeddingProvider } from "./embedding-provider.js";

// ac-4 (scope) — corpus-isolation property end-to-end through the retrieval fns.
const AC4 = "mindset-prod/memex-building-itself/specs/spec-222/acs/ac-4";
// ac-11 — positive per surface: each surface returns only its own chunks.
const AC11 = "mindset-prod/memex-building-itself/specs/spec-222/acs/ac-11";
// ac-12 — isolation negative: a website query can't return app chunks even on a
// text match, AND an unknown surface is rejected.
const AC12 = "mindset-prod/memex-building-itself/specs/spec-222/acs/ac-12";

// One-hot, topic-keyed fake provider (same shape as guide-content.integration.test.ts):
// same topic token → identical vector → cosine distance 0; different topics →
// orthogonal → distance 1 (> the 0.65 floor, dropped). Crucially, the SAME text
// embeds identically regardless of surface, so the vector arm alone cannot tell
// surfaces apart — only the WHERE surface = $surface filter can.
function makeTopicProvider(name = "fake-topic-1536"): EmbeddingProvider {
  const TOPICS = ["specs", "standards", "drift", "pulse"];
  function topicIndex(text: string): number {
    const lower = text.toLowerCase();
    for (let i = 0; i < TOPICS.length; i++) {
      if (lower.includes(TOPICS[i])) return i + 1;
    }
    return 0;
  }
  return {
    name,
    dim: 1536,
    maxBatchSize: 16,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((t) => {
        const v = new Array(1536).fill(0);
        v[topicIndex(t)] = 1;
        return v;
      });
    },
  };
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

describe("corpus surface isolation — positive per surface (ac-11)", () => {
  it("a memex-website search returns ONLY website chunks; a memex-app search ONLY app chunks", async () => {
    tagAc(AC11);
    tagAc(AC4);
    const provider = makeTopicProvider();

    // SAME topic ("specs") under BOTH surfaces — so the vector arm matches both
    // populations equally and only the surface filter separates them.
    await upsertGuideChunk(
      chunk({
        surface: "memex-app",
        sourcePath: "screens/specs-list.md",
        chunkIndex: 0,
        contentHash: "app",
        content: "APP: how the in-product Specs board works.",
      }),
      { provider },
    );
    await upsertGuideChunk(
      chunk({
        surface: "memex-website",
        sourcePath: "website/specs.md",
        chunkIndex: 0,
        contentHash: "web",
        content: "WEBSITE: marketing copy about specs on memex.ai.",
      }),
      { provider },
    );

    const appHits = await searchGuideContent("tell me about specs", {
      surface: "memex-app",
      provider,
    });
    expect(appHits.length).toBe(1);
    expect(appHits[0].sourcePath).toBe("screens/specs-list.md");
    expect(appHits[0].content).toContain("APP:");

    const webHits = await searchGuideContent("tell me about specs", {
      surface: "memex-website",
      provider,
    });
    expect(webHits.length).toBe(1);
    expect(webHits[0].sourcePath).toBe("website/specs.md");
    expect(webHits[0].content).toContain("WEBSITE:");
  });

  it("Layer-1 screen pre-fetch is surface-scoped — same screen_key, different surfaces, no crossover", async () => {
    tagAc(AC11);
    tagAc(AC4);
    // Both surfaces happen to use the same screen_key; the surface filter must
    // still keep them apart. Inserted degraded (no provider) — pure key lookup.
    await upsertGuideChunk(
      chunk({
        surface: "memex-app",
        screenKey: "home",
        sourcePath: "screens/home.md",
        chunkIndex: 0,
        contentHash: "a",
        content: "APP home chunk.",
      }),
      { provider: null },
    );
    await upsertGuideChunk(
      chunk({
        surface: "memex-website",
        screenKey: "home",
        sourcePath: "website/home.md",
        chunkIndex: 0,
        contentHash: "b",
        content: "WEBSITE home chunk.",
      }),
      { provider: null },
    );

    expect(await prefetchScreenContent("home", "memex-app")).toEqual(["APP home chunk."]);
    expect(await prefetchScreenContent("home", "memex-website")).toEqual([
      "WEBSITE home chunk.",
    ]);
  });
});

describe("corpus surface isolation — negative / rejection (ac-12)", () => {
  it("a website-surface search CANNOT return app chunks even when the query text matches app content", async () => {
    tagAc(AC12);
    tagAc(AC4);
    const provider = makeTopicProvider();

    // Only the APP surface has any "specs" content. A website query whose text
    // squarely matches it must still come back empty — the blast-radius boundary.
    await upsertGuideChunk(
      chunk({
        surface: "memex-app",
        sourcePath: "screens/specs-list.md",
        chunkIndex: 0,
        contentHash: "app",
        content: "APP-ONLY: the Specs board and how specs flow through phases.",
      }),
      { provider },
    );

    // Vector arm: query embeds to the same one-hot vector as the app chunk, so
    // WITHOUT the surface filter this would be a direct hit.
    const webVector = await searchGuideContent("tell me about specs", {
      surface: "memex-website",
      provider,
    });
    expect(webVector).toEqual([]);

    // FTS arm (no provider): literal text match on "specs board" — again, the
    // surface filter is the only thing that can keep it out of website results.
    const webFts = await searchGuideContent("specs board", {
      surface: "memex-website",
      provider: null,
    });
    expect(webFts).toEqual([]);

    // Sanity: the app surface DOES see its own content (both arms reach it).
    const appVector = await searchGuideContent("tell me about specs", {
      surface: "memex-app",
      provider,
    });
    expect(appVector.length).toBe(1);
    const appFts = await searchGuideContent("specs board", {
      surface: "memex-app",
      provider: null,
    });
    expect(appFts.length).toBeGreaterThan(0);
  });

  it("an UNKNOWN surface is rejected (throws) — never a silent whole-corpus read", async () => {
    tagAc(AC12);
    tagAc(AC4);
    const provider = makeTopicProvider();
    await upsertGuideChunk(
      chunk({ surface: "memex-app", contentHash: "a", content: "App content." }),
      { provider },
    );

    // Both read paths reject an unconfigured surface rather than returning rows.
    await expect(
      searchGuideContent("specs", { surface: "rogue-surface" as never, provider }),
    ).rejects.toBeInstanceOf(UnknownGuideSurfaceError);
    await expect(
      prefetchScreenContent("specs-list", "rogue-surface" as never),
    ).rejects.toBeInstanceOf(UnknownGuideSurfaceError);

    // The write path rejects it too — a surface-less/garbage write can't land.
    await expect(
      upsertGuideChunk(chunk({ surface: "rogue-surface" as never }), { provider }),
    ).rejects.toBeInstanceOf(UnknownGuideSurfaceError);
  });
});
