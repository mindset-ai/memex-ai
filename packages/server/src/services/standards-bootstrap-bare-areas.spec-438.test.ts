// spec-438 t-4 (ac-6/ac-12): the bootstrap's bare-area fallback reuses the ONE
// defaults source (spec-184's default-standards.fixture.ts) and introduces no
// second, competing defaults list. dec-4: "one source of truth for the defaults,
// shared with the personal-Memex seeder, so there is no second portable list to
// keep in sync." The defaults are an INTERNAL starter set seeded only to personal
// Memexes — never shipped active to orgs.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  DEFAULT_STANDARDS,
  DEFAULT_STANDARDS_COUNT,
} from "../db/default-standards.fixture.js";
import { fetchTopic } from "./guidance.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-438";
const here = dirname(fileURLToPath(import.meta.url));
const seederSource = readFileSync(join(here, "default-standards.ts"), "utf8");

describe("spec-438 t-4 — bare-area checklist reuses the single defaults fixture", () => {
  it("the default-standards fixture is the single, non-empty defaults source (ac-12)", () => {
    tagAc(`${SPEC}/acs/ac-12`);
    expect(DEFAULT_STANDARDS.length).toBe(DEFAULT_STANDARDS_COUNT);
    expect(DEFAULT_STANDARDS.length).toBeGreaterThan(0);
  });

  it("the bootstrap protocol introduces no second defaults list — it does not copy the fixture's standards (ac-12)", async () => {
    tagAc(`${SPEC}/acs/ac-12`);
    const { body } = await fetchTopic("standards-bootstrap");
    // If the protocol had hand-copied the defaults, the fixture's standard titles
    // would appear verbatim in the topic. They must not — the one defaults source
    // stays the fixture; the protocol's bare-area fallback is generic prose.
    for (const std of DEFAULT_STANDARDS) {
      expect(
        body,
        `bootstrap topic must not inline the default standard "${std.title}" (single-source, dec-4)`,
      ).not.toContain(std.title);
    }
  });

  it("the defaults are an internal starter set seeded only to personal Memexes, never shipped active to orgs (ac-6)", () => {
    tagAc(`${SPEC}/acs/ac-6`);
    // the auto-seeder backfills personal namespaces only (kind='user') and never
    // touches team/org Memexes — so the defaults are never shipped to an org.
    expect(seederSource).toMatch(/namespaces\.kind/);
    expect(seederSource).toMatch(/["']user["']/);
    expect(seederSource).toMatch(/never touches team\/org|personal/i);
    // and they are authored through the draft create path (createDocDraft), so
    // even where seeded they land as drafts, never active.
    expect(seederSource).toMatch(/createDocDraft/);
  });
});
