// spec-200 t-1 — storage repo for the What's New feed.
//
// Integration test against the live local Postgres (post-migration 0080). Proves
// the persisted-fields + stable-on-re-read contract (ac-9) and the idempotent
// publish key (no duplicate / no rewrite on re-promotion). Uses test-prefixed
// sourceSpecRefs and cleans them up so the suite leaves no residue.

import { describe, it, expect, afterEach } from "vitest";
import { like } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { whatsNewEntries } from "../db/schema.js";
import { publishEntry, listEntries, getEntryBySpecRef } from "./whats-new.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-200/acs/ac-${n}`;

const TEST_REF_PREFIX = "mindset-prod/memex-building-itself/specs/spec-200-test-";

function entry(handle: string, over: Partial<Parameters<typeof publishEntry>[0]> = {}) {
  return {
    sourceSpecRef: `${TEST_REF_PREFIX}${handle}`,
    sourceSpecHandle: handle,
    title: `What's New for ${handle}`,
    whatText: `WHAT shipped in ${handle}.`,
    whyText: `WHY ${handle} matters to users.`,
    ...over,
  };
}

afterEach(async () => {
  await db.delete(whatsNewEntries).where(like(whatsNewEntries.sourceSpecRef, `${TEST_REF_PREFIX}%`));
});

describe("whats-new repo (spec-200 t-1)", () => {
  it("persists what/why/spec-ref/published-at and returns identical content on re-read (ac-9)", async () => {
    const input = entry("spec-aa");
    const published = await publishEntry(input);
    expect(published).not.toBeNull();

    const reread = await getEntryBySpecRef(input.sourceSpecRef);
    expect(reread).not.toBeNull();
    // Every persisted field round-trips identically — entries are stable/citable,
    // never regenerated per read.
    expect(reread!.sourceSpecRef).toBe(input.sourceSpecRef);
    expect(reread!.sourceSpecHandle).toBe(input.sourceSpecHandle);
    expect(reread!.title).toBe(input.title);
    expect(reread!.whatText).toBe(input.whatText);
    expect(reread!.whyText).toBe(input.whyText);
    expect(reread!.publishedAt).toBeInstanceOf(Date);

    tagAc(AC(9));
  });

  it("is idempotent on sourceSpecRef — re-publish is a no-op, never a duplicate or rewrite (ac-9)", async () => {
    const first = await publishEntry(entry("spec-bb", { whatText: "original" }));
    expect(first).not.toBeNull();

    // Re-running the promotion with the same source Spec (even with different
    // generated prose) must not duplicate or overwrite.
    const second = await publishEntry(entry("spec-bb", { whatText: "regenerated" }));
    expect(second).toBeNull();

    const stored = await getEntryBySpecRef(`${TEST_REF_PREFIX}spec-bb`);
    expect(stored!.whatText).toBe("original");

    tagAc(AC(9));
  });

  it("lists entries newest-first (ac-9 ordering foundation)", async () => {
    await publishEntry(entry("spec-cc"));
    await new Promise((r) => setTimeout(r, 5));
    await publishEntry(entry("spec-dd"));

    const list = await listEntries();
    const mine = list.filter((e) => e.sourceSpecRef.startsWith(TEST_REF_PREFIX));
    expect(mine.map((e) => e.sourceSpecHandle)).toEqual(["spec-dd", "spec-cc"]);

    tagAc(AC(9));
  });
});
