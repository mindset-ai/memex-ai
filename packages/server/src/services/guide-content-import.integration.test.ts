// spec-190 t-7 (dec-7) — integration tests for the guide-content import pipeline.
// Covers ac-18: frontmatter validation against the registry (fail unknown
// screen/element, warn registered screens with no content), heading-bounded
// chunking, upsert keyed by source_path + content_hash (unchanged chunks never
// re-embedded), orphan pruning, and check-mode (validate only, no DB writes).
//
// Pure functions (parseFrontmatter, chunkMarkdown, validateGuideContent) are
// asserted directly; the import path uses a temp guide-content dir + the real
// test DB + a deterministic fake EmbeddingProvider so the no-re-embed and prune
// behaviour is observable.

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import {
  parseFrontmatter,
  chunkMarkdown,
  validateGuideContent,
  loadGuideContentFiles,
  importGuideContent,
  resolveGuideContentDir,
  GuideContentValidationError,
  type ParsedGuideFile,
} from "./guide-content-import.js";
import { REGISTERED_SCREEN_KEYS } from "@memex/shared";
import type { EmbeddingProvider } from "./embedding-provider.js";

const AC18 = "mindset-prod/memex-building-itself/specs/spec-190/acs/ac-18";

function makeFakeProvider(name = "fake-import-1536"): EmbeddingProvider & {
  calls: number;
} {
  const provider = {
    name,
    dim: 1536,
    maxBatchSize: 16,
    calls: 0,
    async embed(texts: string[]): Promise<number[][]> {
      provider.calls += texts.length;
      return texts.map((t) => {
        const seed = Array.from(t).reduce((a, c) => a + c.charCodeAt(0), 0);
        return Array.from({ length: 1536 }, (_, i) => ((seed + i) % 100) / 100);
      });
    },
  };
  return provider;
}

async function clearCorpus(): Promise<void> {
  await db.execute(sql`DELETE FROM guide_content`);
}
async function rowCount(): Promise<number> {
  const rows = (await db.execute(
    sql`SELECT count(*)::int AS n FROM guide_content`,
  )) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

const tmpDirs: string[] = [];
function makeContentDir(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "guide-content-"));
  tmpDirs.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body, "utf-8");
  }
  return root;
}

beforeEach(clearCorpus);
afterAll(async () => {
  await clearCorpus();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe("frontmatter + chunking (ac-18)", () => {
  it("parses scalar and list frontmatter and splits body from frontmatter", () => {
    tagAc(AC18);
    const { frontmatter, body } = parseFrontmatter(
      "---\nscreen: specs-list\nelements: [a, b, c]\n---\n# Heading\nbody text\n",
    );
    expect(frontmatter.screen).toBe("specs-list");
    expect(frontmatter.elements).toEqual(["a", "b", "c"]);
    expect(body).toBe("# Heading\nbody text");
  });

  it("treats a file with no frontmatter as all-body", () => {
    tagAc(AC18);
    const { frontmatter, body } = parseFrontmatter("# Just content\nno fences");
    expect(frontmatter).toEqual({});
    expect(body).toBe("# Just content\nno fences");
  });

  it("chunks markdown on heading boundaries", () => {
    tagAc(AC18);
    const chunks = chunkMarkdown("# One\nalpha\n## Two\nbeta\n## Three\ngamma");
    expect(chunks.map((c) => c.heading)).toEqual(["One", "Two", "Three"]);
    expect(chunks[1].content).toContain("beta");
  });
});

describe("validation against the registry (ac-18)", () => {
  function screenFile(over: Partial<ParsedGuideFile>): ParsedGuideFile {
    return {
      sourcePath: "screens/specs-list.md",
      screenKey: "specs-list",
      elementRefs: [],
      isScreen: true,
      chunks: [{ heading: "H", content: "body" }],
      ...over,
    };
  }

  it("errors on an unknown screen key", () => {
    tagAc(AC18);
    const { errors } = validateGuideContent([
      screenFile({ sourcePath: "screens/nope.md", screenKey: "nope" as never }),
    ]);
    expect(errors.some((e) => e.includes("not a known screen key"))).toBe(true);
  });

  it("errors on an element id not registered on the screen", () => {
    tagAc(AC18);
    const { errors } = validateGuideContent([
      screenFile({ elementRefs: ["new-spec-button", "made-up-element"] }),
    ]);
    expect(errors.some((e) => e.includes("made-up-element"))).toBe(true);
    expect(errors.some((e) => e.includes("new-spec-button"))).toBe(false);
  });

  it("errors when the filename doesn't match the declared screen", () => {
    tagAc(AC18);
    const { errors } = validateGuideContent([
      screenFile({ sourcePath: "screens/wrong-name.md", screenKey: "specs-list" }),
    ]);
    expect(errors.some((e) => e.includes("does not match"))).toBe(true);
  });

  it("warns on registered screens with no content file", () => {
    tagAc(AC18);
    // Only specs-list provided → the other registered screens warn.
    const { warnings } = validateGuideContent([screenFile({})]);
    const others = REGISTERED_SCREEN_KEYS.filter((k) => k !== "specs-list");
    for (const k of others) {
      expect(warnings.some((w) => w.includes(k))).toBe(true);
    }
  });

  it("the shipped guide-content/ dir validates clean (no errors)", async () => {
    tagAc(AC18);
    const files = await loadGuideContentFiles(resolveGuideContentDir());
    const { errors } = validateGuideContent(files);
    expect(errors).toEqual([]);
  });
});

describe("import: upsert-by-hash, prune, check-mode (ac-18)", () => {
  it("imports chunks, then reuses unchanged chunks on re-run (no re-embed)", async () => {
    tagAc(AC18);
    const dir = makeContentDir({
      "screens/specs-list.md":
        "---\nscreen: specs-list\nelements: [new-spec-button]\n---\n# A\nalpha\n## B\nbeta\n",
      "concepts/phases.md": "---\ntopic: phases\n---\n# Phases\nthe pipeline\n",
    });
    const provider = makeFakeProvider();

    const first = await importGuideContent({ dir, provider });
    expect(first.chunksSeen).toBe(3); // A, B, Phases
    expect(first.chunksEmbedded).toBe(3);
    expect(provider.calls).toBe(3);
    expect(await rowCount()).toBe(3);

    const second = await importGuideContent({ dir, provider });
    expect(second.chunksReused).toBe(3);
    expect(second.chunksEmbedded).toBe(0);
    expect(provider.calls).toBe(3); // unchanged — NOT re-embedded
  });

  it("re-embeds only the chunk whose content changed", async () => {
    tagAc(AC18);
    const dir = makeContentDir({
      "screens/specs-list.md": "---\nscreen: specs-list\n---\n# A\nalpha\n## B\nbeta\n",
    });
    const provider = makeFakeProvider();
    await importGuideContent({ dir, provider });
    expect(provider.calls).toBe(2);

    // Change only chunk B's content.
    writeFileSync(
      join(dir, "screens/specs-list.md"),
      "---\nscreen: specs-list\n---\n# A\nalpha\n## B\nBETA CHANGED\n",
      "utf-8",
    );
    const res = await importGuideContent({ dir, provider });
    expect(res.chunksEmbedded).toBe(1);
    expect(res.chunksReused).toBe(1);
    expect(provider.calls).toBe(3); // one more embed
  });

  it("prunes rows whose source file no longer exists", async () => {
    tagAc(AC18);
    const dir = makeContentDir({
      "screens/specs-list.md": "---\nscreen: specs-list\n---\n# A\nalpha\n",
      "concepts/phases.md": "---\ntopic: phases\n---\n# P\nbody\n",
    });
    const provider = makeFakeProvider();
    await importGuideContent({ dir, provider });
    expect(await rowCount()).toBe(2);

    // Remove the concept file and re-import.
    rmSync(join(dir, "concepts/phases.md"));
    const res = await importGuideContent({ dir, provider });
    expect(res.rowsPruned).toBe(1);
    expect(await rowCount()).toBe(1);
  });

  it("check mode validates without any DB writes", async () => {
    tagAc(AC18);
    const dir = makeContentDir({
      "screens/specs-list.md": "---\nscreen: specs-list\n---\n# A\nalpha\n",
    });
    const provider = makeFakeProvider();
    const res = await importGuideContent({ dir, check: true, provider });
    expect(res.checkOnly).toBe(true);
    expect(provider.calls).toBe(0);
    expect(await rowCount()).toBe(0); // nothing written
  });

  it("throws GuideContentValidationError on a bad reference (the CI gate)", async () => {
    tagAc(AC18);
    const dir = makeContentDir({
      "screens/specs-list.md":
        "---\nscreen: specs-list\nelements: [does-not-exist]\n---\n# A\nalpha\n",
    });
    await expect(importGuideContent({ dir, check: true })).rejects.toBeInstanceOf(
      GuideContentValidationError,
    );
    expect(await rowCount()).toBe(0);
  });
});
