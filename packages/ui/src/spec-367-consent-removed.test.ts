// spec-367 — the anonymous consent popup and its client consent/mint helpers are
// RETIRED (dec-1, dec-5). This guard fails if any of them reappears, or if the popup
// is re-mounted in main.tsx.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const AC = "mindset-prod/memex-building-itself/specs/spec-367/acs";
const here = dirname(fileURLToPath(import.meta.url));
const at = (rel: string): string => resolve(here, rel);

describe("spec-367 — the consent popup + client mint helpers are gone (ac-1, ac-11)", () => {
  it("the VisitorConsent component and its consent/visitorId lib modules no longer exist", () => {
    tagAc(`${AC}/ac-1`);
    tagAc(`${AC}/ac-11`);
    expect(existsSync(at("components/VisitorConsent.tsx"))).toBe(false);
    expect(existsSync(at("lib/visitorConsent.ts"))).toBe(false);
    expect(existsSync(at("lib/visitorId.ts"))).toBe(false);
  });

  it("main.tsx does not mount a consent banner", () => {
    tagAc(`${AC}/ac-1`);
    const main = readFileSync(at("main.tsx"), "utf8");
    expect(main).not.toMatch(/VisitorConsent/);
  });
});
