// spec-222 t-8 (dec-3 → ac-13) — integration tests for WEBSITE corpus ingestion.
//
// The marketing site publishes a FLAT llms-full.txt (no screens/concepts
// frontmatter). importWebsiteCorpus chunks it with the SAME pipeline primitives
// as the app import (chunkMarkdown / hashContent / upsertGuideChunk) and tags
// every chunk surface "memex-website" (screen_key NULL). These tests prove:
//   * chunks land under surface "memex-website" and are retrievable via
//     searchGuideContent({surface:"memex-website"}) — but NOT under "memex-app";
//   * a re-run with unchanged content is idempotent (no duplicate rows, no
//     re-embed — content_hash respected);
//   * the website import never prunes / touches the app corpus.
//
// Same posture as the surface-isolation suite: a topic-keyed one-hot fake
// EmbeddingProvider makes the vector arm assertable against the real test DB.

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import {
  importWebsiteCorpus,
  WEBSITE_CORPUS_SOURCE_PATH,
} from "./guide-content-import.js";
import {
  upsertGuideChunk,
  searchGuideContent,
  type GuideChunkInput,
} from "./guide-content.js";
import type { EmbeddingProvider } from "./embedding-provider.js";

const AC13 = "mindset-prod/memex-building-itself/specs/spec-222/acs/ac-13";

// A small, multi-section flat artifact shaped like the published llms-full.txt —
// NO frontmatter, just headings. Topic tokens ("specs", "standards", "drift")
// line up with the fake provider so the vector arm is deterministic.
const FIXTURE_LLMS_FULL = `# Memex AI — Full Reference

> The living spec your agents build from.

Memex is a live specification and verification system.

## Specs

A Spec represents an objective. Specs are the boundary that prevents context from sprawling.

## Standards

Standards are the shared contracts between humans and AI — prescriptive, scoped rules.

## Drift Detection

Four mechanisms keep institutional knowledge current and catch drift early.
`;

// One-hot topic-keyed provider (same shape as the surface-isolation suite).
function makeTopicProvider(name = "fake-website-1536"): EmbeddingProvider & {
  calls: number;
} {
  const TOPICS = ["specs", "standards", "drift", "reference"];
  function topicIndex(text: string): number {
    const lower = text.toLowerCase();
    for (let i = 0; i < TOPICS.length; i++) {
      if (lower.includes(TOPICS[i])) return i + 1;
    }
    return 0;
  }
  const provider = {
    name,
    dim: 1536,
    maxBatchSize: 16,
    calls: 0,
    async embed(texts: string[]): Promise<number[][]> {
      provider.calls += texts.length;
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
async function rowCount(surface?: string): Promise<number> {
  const rows = (await db.execute(
    surface
      ? sql`SELECT count(*)::int AS n FROM guide_content WHERE surface = ${surface}`
      : sql`SELECT count(*)::int AS n FROM guide_content`,
  )) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

beforeEach(clearCorpus);
afterAll(clearCorpus);

describe("website corpus ingestion (spec-222 t-8 → ac-13)", () => {
  it("chunks a flat llms-full.txt and lands every chunk under surface memex-website", async () => {
    tagAc(AC13);
    const provider = makeTopicProvider();
    const summary = await importWebsiteCorpus({
      source: { content: FIXTURE_LLMS_FULL },
      provider,
    });

    // The fixture has a preamble + three "##" sections → 4 heading-bounded chunks.
    expect(summary.chunksSeen).toBe(4);
    expect(summary.chunksEmbedded).toBe(4);

    // Every persisted row carries surface "memex-website", screen_key NULL, and the
    // stable source_path.
    const rows = (await db.execute(sql`
      SELECT surface, screen_key, source_path, chunk_index
      FROM guide_content ORDER BY chunk_index
    `)) as unknown as Array<{
      surface: string;
      screen_key: string | null;
      source_path: string;
      chunk_index: number;
    }>;
    expect(rows.length).toBe(4);
    for (const r of rows) {
      expect(r.surface).toBe("memex-website");
      expect(r.screen_key).toBeNull();
      expect(r.source_path).toBe(WEBSITE_CORPUS_SOURCE_PATH);
    }
  });

  it("ingested chunks are retrievable under memex-website but NOT under memex-app", async () => {
    tagAc(AC13);
    const provider = makeTopicProvider();
    await importWebsiteCorpus({ source: { content: FIXTURE_LLMS_FULL }, provider });

    // Vector arm: a website query for "standards" hits the website section.
    const webHits = await searchGuideContent("tell me about standards", {
      surface: "memex-website",
      provider,
    });
    expect(webHits.length).toBeGreaterThan(0);
    expect(webHits.some((h) => h.content.includes("Standards are the shared contracts"))).toBe(
      true,
    );

    // The SAME query on the app surface returns nothing — the website corpus is
    // invisible to app sessions (the isolation boundary).
    const appHits = await searchGuideContent("tell me about standards", {
      surface: "memex-app",
      provider,
    });
    expect(appHits).toEqual([]);

    // FTS arm too (no provider): a website literal match works, app stays empty.
    const webFts = await searchGuideContent("drift detection", {
      surface: "memex-website",
      provider: null,
    });
    expect(webFts.length).toBeGreaterThan(0);
    const appFts = await searchGuideContent("drift detection", {
      surface: "memex-app",
      provider: null,
    });
    expect(appFts).toEqual([]);
  });

  it("a re-run with unchanged content is idempotent — no duplicate rows, content_hash respected", async () => {
    tagAc(AC13);
    const provider = makeTopicProvider();

    const first = await importWebsiteCorpus({
      source: { content: FIXTURE_LLMS_FULL },
      provider,
    });
    expect(first.chunksEmbedded).toBe(4);
    expect(provider.calls).toBe(4);
    expect(await rowCount()).toBe(4);

    const second = await importWebsiteCorpus({
      source: { content: FIXTURE_LLMS_FULL },
      provider,
    });
    // Unchanged → every chunk reused, nothing re-embedded, NO duplicate rows.
    expect(second.chunksReused).toBe(4);
    expect(second.chunksEmbedded).toBe(0);
    expect(provider.calls).toBe(4); // still 4 — no re-embed
    expect(await rowCount()).toBe(4);
  });

  it("re-embeds only changed chunks and prunes orphaned tail chunks (website surface only)", async () => {
    tagAc(AC13);
    const provider = makeTopicProvider();
    await importWebsiteCorpus({ source: { content: FIXTURE_LLMS_FULL }, provider });
    expect(await rowCount()).toBe(4);
    const callsAfterFirst = provider.calls;

    // Re-publish a SHORTER doc (drops the Drift section, edits Standards).
    const shorter = `# Memex AI — Full Reference

Memex is a live specification and verification system.

## Specs

A Spec represents an objective. Specs are the boundary that prevents context from sprawling.

## Standards

Standards are durable rules — EDITED COPY for this run.
`;
    const res = await importWebsiteCorpus({ source: { content: shorter }, provider });
    // 3 chunks now; the edited Standards chunk re-embeds, the orphaned 4th prunes.
    expect(res.chunksSeen).toBe(3);
    expect(res.rowsPruned).toBe(1);
    expect(await rowCount()).toBe(3);
    expect(provider.calls).toBeGreaterThan(callsAfterFirst); // the edit re-embedded
  });

  it("the website import never prunes or alters the app corpus", async () => {
    tagAc(AC13);
    const provider = makeTopicProvider();

    // Seed an app chunk first (different surface, unrelated source_path).
    const appChunk: GuideChunkInput = {
      surface: "memex-app",
      screenKey: "specs-list",
      sourcePath: "screens/specs-list.md",
      chunkIndex: 0,
      heading: "Specs board",
      contentHash: "app-hash",
      content: "APP: how the in-product Specs board works.",
    };
    await upsertGuideChunk(appChunk, { provider });
    expect(await rowCount("memex-app")).toBe(1);

    // Run the website import — it must leave the app row entirely untouched.
    await importWebsiteCorpus({ source: { content: FIXTURE_LLMS_FULL }, provider });
    expect(await rowCount("memex-app")).toBe(1);
    expect(await rowCount("memex-website")).toBe(4);

    const appStill = await searchGuideContent("specs board", {
      surface: "memex-app",
      provider: null,
    });
    expect(appStill.length).toBeGreaterThan(0);
  });
});
