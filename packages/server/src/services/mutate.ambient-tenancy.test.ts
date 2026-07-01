// spec-440 ac-12 (dec-3): this Spec keeps tenant identity AMBIENT
// (AsyncLocalStorage via runWithMemexId) and deliberately does NOT thread an
// explicit memexId/RequestCtx through mutate(). The durable type-level fix —
// making tenancy carried by the write rather than ambient — is recorded as a
// follow-on (spec-440 issue-1), not built here (its marginal value drops once
// the loud guard + restricted-role CI harness land). This test guards that
// decision: if someone later adds a memexId to mutate()'s RequestCtx, they must
// revisit dec-3 rather than drift into a half-done refactor.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";

const AC_12 = "mindset-prod/memex-building-itself/specs/spec-440/acs/ac-12";

describe("spec-440 ac-12: mutate() tenancy stays ambient (dec-3)", () => {
  it("mutate()'s RequestCtx does NOT carry a memexId — tenancy is not threaded through mutate", () => {
    tagAc(AC_12);

    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "./mutate.ts"),
      "utf8",
    );

    // Isolate the RequestCtx interface body so an unrelated `memexId` elsewhere
    // in the file (e.g. ChangeKey.memexId, which is the bus key — not the write's
    // ambient tenant) can't mask a real change to the write context.
    const match = /export interface RequestCtx\s*\{([\s\S]*?)\n\}/.exec(src);
    expect(match, "RequestCtx interface not found in mutate.ts").not.toBeNull();
    const body = match![1]!;

    expect(
      /\bmemexId\b/.test(body),
      "RequestCtx gained a memexId — dec-3 chose ambient ALS + guard over threading " +
        "an explicit tenant id through mutate(). Revisit spec-440 dec-3 / issue-1 before adding this.",
    ).toBe(false);
  });
});
