// spec-367 dec-5 — the visitor_id machinery is RETAINED DORMANT, not removed.
//
// Pure-stateless pre-signup capture mints no visitor_id, so the schema + server reader
// are unused today. They are deliberately kept (to hold the door open for a future
// anonymous→user stitch) and MUST carry a dormant-by-design marker so a later cleanup
// pass doesn't rip them out as dead code. This guard fails if either the retention or
// the marker regresses.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { visitors, usageEvents } from "../db/schema.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-367/acs";
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(resolve(here, rel), "utf8");

describe("spec-367 — visitor_id retained dormant-by-design (ac-11, ac-5)", () => {
  it("the visitors table and usage_events.visitor_id column are still present (retained)", () => {
    tagAc(`${AC}/ac-11`);
    tagAc(`${AC}/ac-5`);
    // Programmatic: the Drizzle tables/columns still exist (not dropped).
    expect(visitors).toBeDefined();
    expect(usageEvents.visitorId).toBeDefined();
  });

  it("the schema + server reader carry the spec-367 dormant-by-design marker", () => {
    tagAc(`${AC}/ac-11`);
    const schema = read("../db/schema.ts");
    const middleware = read("../middleware/visitor.ts");
    // Both the visitors table and the visitor_id column note the dormant retention.
    expect(schema).toMatch(/DORMANT-BY-DESIGN \(spec-367/);
    expect(middleware).toMatch(/DORMANT-BY-DESIGN \(spec-367/);
  });
});
