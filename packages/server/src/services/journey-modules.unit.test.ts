// spec-303 impl ac-17 (dec-10) — the journey modules are a STATE SIGNAL + an
// AUTHORISATION check, never a billing/entitlement store. Verified two ways:
// the single accessors exist (the indirection principle), and no journey module
// imports a billing/entitlement/stripe store.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";
import { getUserJourneyState } from "./journey-state.js";
import { canPreviewJourneys } from "./journey-preview.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-303/acs/ac-${n}`;

const here = dirname(fileURLToPath(import.meta.url));

describe("journey modules — layering (ac-17)", () => {
  it("expose a single journey-state accessor + a capability check", () => {
    tagAc(AC(17));
    expect(typeof getUserJourneyState).toBe("function");
    expect(typeof canPreviewJourneys).toBe("function");
  });

  it("import no billing / entitlement / stripe store in any journey module", () => {
    tagAc(AC(17));
    const files = [
      "journey-state.ts",
      "journey-preview.ts",
      join("..", "journeys", "onboarding.ts"),
      join("..", "journeys", "index.ts"),
      join("..", "routes", "journey.ts"),
    ].map((rel) => readFileSync(join(here, rel), "utf8"));

    for (const src of files) {
      const importLines = src
        .split("\n")
        .filter((l) => l.trim().startsWith("import"));
      for (const line of importLines) {
        expect(line).not.toMatch(/entitlement|billing|stripe/i);
      }
    }
  });
});
