// spec-340 t-10 / dec-6 — the no-hooks scope boundary. v1 is the hook-INDEPENDENT
// substrate: NO client-side hook, phone-home-on-edit, or in-flow injection is
// introduced. Delivery rides MCP tools only (create_task + assess_spec). This
// guard pins both so the deferred sibling spec's surface can't leak into v1.
// Source-text assertions, no DB.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-340/acs/ac-${n}`;

const SERVICES = join(__dirname, "..", "services");
const HANDLERS = join(__dirname, "..", "agent", "handlers");
const read = (p: string) => readFileSync(p, "utf8");

// Every spec-340 facet service module (non-test).
const facetFiles = readdirSync(SERVICES).filter(
  (f) => (f.startsWith("facet") || f === "default-facets.ts") && f.endsWith(".ts") && !f.includes(".test."),
);

describe("spec-340 introduces no client-side hooks (ac-23)", () => {
  it("no facet module installs a file-watch / phone-home / in-flow injection surface", () => {
    tagAc(AC(23));
    expect(facetFiles.length).toBeGreaterThan(0);
    for (const f of facetFiles) {
      const src = read(join(SERVICES, f));
      expect(src).not.toMatch(/chokidar|fs\.watch|watchFile|\.watch\(|phone.?home|onFileEdit|preToolUse|postToolUse/i);
    }
  });

  it("delivery rides MCP tools only — the ballot on create_task, the gate on assess_spec (ac-23)", () => {
    tagAc(AC(23));
    // The two (and only) v1 delivery surfaces are existing MCP tools.
    expect(read(join(HANDLERS, "tasks.ts"))).toMatch(/facetBallot/);
    expect(read(join(HANDLERS, "lifecycle.ts"))).toMatch(/facetAck/);
  });
});
