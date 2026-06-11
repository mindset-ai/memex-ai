// Unit tests for the usage-event registry (spec-244 dec-5 / t-2).

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  USAGE_EVENT_REGISTRY,
  isRegisteredEvent,
  isFrontendEvent,
  getUsageEventDef,
  BACKEND_EVENT_NAMES,
  sanitizeUsageProps,
} from "./usage-events-registry.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-244/acs";

describe("registry — the typed allowlist (ac-3)", () => {
  it("recognises registered names and rejects unregistered ones", () => {
    tagAc(`${AC}/ac-3`);
    expect(isRegisteredEvent("spec.create_clicked")).toBe(true);
    expect(isRegisteredEvent("document.created")).toBe(true);
    expect(isRegisteredEvent("totally.made_up")).toBe(false);
    expect(getUsageEventDef("totally.made_up")).toBeUndefined();
  });

  it("splits front-end from back-end, and back-end names are entity.action shaped", () => {
    tagAc(`${AC}/ac-3`);
    expect(isFrontendEvent("spec.create_clicked")).toBe(true);
    expect(isFrontendEvent("document.created")).toBe(false); // back-end outcome
    // Every back-end name is `${entity}.${action}` so the dec-8 whitelist maps 1:1.
    for (const name of BACKEND_EVENT_NAMES) {
      expect(name).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
    // Every entry carries a non-empty plain-English description (the human contract).
    for (const def of USAGE_EVENT_REGISTRY) {
      expect(def.description.length).toBeGreaterThan(10);
    }
  });
});

describe("sanitizeUsageProps — content structurally cannot land (ac-7)", () => {
  it("keeps ids/enums/counts, drops long free-text, emails, and nested structures", () => {
    tagAc(`${AC}/ac-7`);
    const cleaned = sanitizeUsageProps({
      surface: "header_cta", // short enum — kept
      count: 3, // number — kept
      ok: true, // boolean — kept
      email: "someone@example.com", // email-shaped — dropped
      note: "x".repeat(200), // free-text — dropped
      nested: { secret: "data" }, // structure — dropped
      list: [1, 2, 3], // array — dropped
    });
    expect(cleaned).toEqual({ surface: "header_cta", count: 3, ok: true });
  });

  it("returns undefined for empty / all-dropped / nullish input", () => {
    tagAc(`${AC}/ac-7`);
    expect(sanitizeUsageProps(undefined)).toBeUndefined();
    expect(sanitizeUsageProps(null)).toBeUndefined();
    expect(sanitizeUsageProps({ email: "a@b.co" })).toBeUndefined();
  });
});
