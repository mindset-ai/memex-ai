// b-90 ac-1 — no agent-facing surface mentions `localhost:8080` as a default
// or fallback destination for test-event emissions.
//
// The b-68 incident traced partly to "localhost is the default" priming in
// the helper source comments and the architecture doc. Every such mention
// is removed; this test guards that the absence stays absent.
//
// spec-89 v0.1.0: the four in-tree helper copies (template + three dogfood)
// have collapsed into a single workspace package at packages/ac-emit-vitest/.
// This test now asserts the trapdoor is absent from that single source plus
// the supporting docs.
//
// Surfaces inspected:
//   - The workspace package's helper source files.
//   - docs/ac-primitive-hypothesis.md (no "default localhost" claim).
//   - packages/server/src/app.ts (no leftover comment about the removed
//     /install/ route claiming localhost is the default).
//
// What this test does NOT guard:
//   - README mentions of localhost (legitimate dev-setup docs for running
//     the server locally; not about test-event routing).
//   - docs/local-mcp-client.md (explicitly a "point Claude at a fully-local
//     Memex" guide; localhost is the literal subject matter).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

const HELPER_SOURCES = [
  join(REPO_ROOT, "packages", "ac-emit-vitest", "src", "derive-url.ts"),
  join(REPO_ROOT, "packages", "ac-emit-vitest", "src", "emit.ts"),
];

const HYPOTHESIS_DOC = join(REPO_ROOT, "docs", "ac-primitive-hypothesis.md");
const APP_TS = join(REPO_ROOT, "packages", "server", "src", "app.ts");

describe("b-90 ac-1: no localhost:8080 mentions in agent-facing emission surfaces", () => {
  describe("workspace helper source", () => {
    for (const path of HELPER_SOURCES) {
      describe(path.split("/").slice(-3).join("/"), () => {
        const src = readFileSync(path, "utf-8");

        it("contains no FALLBACK_URL = http://localhost:8080 constant", () => {
          tagAc("mindset-prod/memex-building-itself/specs/spec-90/acs/ac-1");
          expect(src).not.toMatch(/FALLBACK_URL\s*=\s*['"]http:\/\/localhost/);
        });

        it("contains no DEFAULT_URL = http://localhost:8080 constant", () => {
          tagAc("mindset-prod/memex-building-itself/specs/spec-90/acs/ac-1");
          expect(src).not.toMatch(/DEFAULT_URL\s*=\s*['"]http:\/\/localhost/);
        });

        it("does not describe localhost:8080 as a 'default' destination in comments", () => {
          tagAc("mindset-prod/memex-building-itself/specs/spec-90/acs/ac-1");
          // The phrasing that primed the b-68 mistake: "defaults to
          // http://localhost:8080" or "default ... localhost:8080".
          expect(src).not.toMatch(/default[^.]*\bhttp:\/\/localhost:8080/i);
        });
      });
    }
  });

  describe("supporting docs", () => {
    it("docs/ac-primitive-hypothesis.md no longer names localhost:8080 as a default", () => {
      tagAc("mindset-prod/memex-building-itself/specs/spec-90/acs/ac-1");
      const src = readFileSync(HYPOTHESIS_DOC, "utf-8");
      // The phrase "default `http://localhost:8080/api/test-events`" was the
      // misleading one. The doc may still mention localhost in dev-setup
      // contexts, but it must not describe localhost as the *default*
      // destination for test-event emissions.
      expect(src).not.toMatch(/default\s+`http:\/\/localhost:8080\/api\/test-events`/);
    });

    it("packages/server/src/app.ts /install/ route comment does not claim localhost is the helper's default", () => {
      tagAc("mindset-prod/memex-building-itself/specs/spec-90/acs/ac-1");
      const src = readFileSync(APP_TS, "utf-8");
      // The pre-b-90 comment said: "the helper's DEFAULT_URL is hardcoded to
      // localhost:8080". With FALLBACK_URL removed and namespace routing in
      // place, that framing is wrong and would mislead a future reader.
      expect(src).not.toMatch(/DEFAULT_URL\s+is\s+hardcoded\s+to\s+localhost/i);
      expect(src).not.toMatch(/hardcoded\s+to\s+localhost:8080/i);
    });
  });
});
