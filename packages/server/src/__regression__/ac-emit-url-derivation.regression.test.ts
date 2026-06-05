// Regression guard: the AC emit helper routes each tagged ref to the right
// hosted Memex by deriving the URL from the namespace, AND never falls back
// to localhost when neither namespace mapping nor explicit override applies.
//
// The trap this originally guarded: agents writing tests that tag refs
// against an int-hosted Spec but emitting silently to localhost. Caught
// during the b-65 test drive — events landed in local Postgres while the UI
// on int.memex.ai sat at zero. Fixed by adding namespace-based URL
// derivation.
//
// b-90 hardens this further: the helper no longer has a hardcoded
// localhost FALLBACK_URL at all. When a ref's namespace isn't in the map
// AND no MEMEX_TEST_EVENTS_URL is set, the helper logs a warning and
// returns null — the emission loop skips the POST. There is no default
// destination to fall through to.
//
// spec-89 v0.1.0: the four in-tree copies of this helper have collapsed
// into a single workspace package at packages/ac-emit-vitest/. Server,
// admin, and shared all depend on @memex-ai-ac/vitest via the workspace.
// This regression test now asserts the contract against that single
// source — assertions about the bootstrap template and dogfood copies
// (which no longer exist) are gone.
//
// Asserts:
//   1. The workspace package's derive-url.ts contains the
//      NAMESPACE_TO_BASE_URL mapping.
//   2. Maps mindset-int → int.memex.ai and mindset-prod → memex.ai.
//   3. Reads MEMEX_TEST_EVENTS_URL via process.env (still honoured as an
//      explicit override).
//   4. deriveEventsUrl signature returns `string | null` (no hardcoded
//      default destination).
//   5. Contains no `FALLBACK_URL` / `DEFAULT_URL` constant pointing at
//      localhost.
//   6. The ac-emission guidance topic still explains namespace routing.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";

const SPEC_89 = "mindset-prod/memex-building-itself/specs/spec-89/acs";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const HELPER_SOURCE = join(
  REPO_ROOT,
  "packages",
  "ac-emit-vitest",
  "src",
  "derive-url.ts",
);
const GUIDANCE = join(
  REPO_ROOT,
  "packages",
  "server",
  "src",
  "guidance",
  "ac-emission.json",
);
const THIS_FILE = join(
  REPO_ROOT,
  "packages",
  "server",
  "src",
  "__regression__",
  "ac-emit-url-derivation.regression.test.ts",
);

describe("AC emit URL derivation — namespace routing + no localhost trapdoor", () => {
  const src = readFileSync(HELPER_SOURCE, "utf-8");

  it("contains a NAMESPACE_TO_BASE_URL mapping", () => {
    expect(src).toMatch(/NAMESPACE_TO_BASE_URL/);
  });

  it("maps mindset-int → https://int.memex.ai", () => {
    expect(src).toMatch(
      /['"]mindset-int['"]\s*:\s*['"]https:\/\/int\.memex\.ai['"]/,
    );
  });

  it("maps mindset-prod → https://memex.ai", () => {
    expect(src).toMatch(
      /['"]mindset-prod['"]\s*:\s*['"]https:\/\/memex\.ai['"]/,
    );
  });

  it("honours MEMEX_TEST_EVENTS_URL as an explicit override", () => {
    expect(src).toMatch(/process\.env\.MEMEX_TEST_EVENTS_URL/);
  });

  it("deriveEventsUrl returns string | null (no hardcoded default)", () => {
    // The b-90 contract: when no destination is determinable, return null
    // and skip the POST. Don't fall through to a hardcoded URL.
    expect(src).toMatch(/function\s+deriveEventsUrl[^{]*string\s*\|\s*null/);
    expect(src).toMatch(/return\s+null/);
  });

  it("contains no FALLBACK_URL / DEFAULT_URL constant pointing at localhost", () => {
    // The localhost trapdoor that primed the b-68 mistake is gone.
    expect(src).not.toMatch(/FALLBACK_URL\s*=\s*['"]http:\/\/localhost/);
    expect(src).not.toMatch(/DEFAULT_URL\s*=\s*['"]http:\/\/localhost/);
  });

  it("ac-emission guidance topic still explains namespace routing", () => {
    const topic = JSON.parse(readFileSync(GUIDANCE, "utf-8")) as {
      body: string;
    };
    expect(topic.body).toMatch(/namespace/i);
    expect(topic.body).toMatch(/mindset-int/);
    expect(topic.body).toMatch(/mindset-prod/);
    expect(topic.body).toMatch(/MEMEX_TEST_EVENTS_URL/);
  });

  it("ac-emission guidance topic documents only npm install for v0.1.0+ helper [spec-89 ac-7]", () => {
    tagAc(`${SPEC_89}/ac-7`);
    const topic = JSON.parse(readFileSync(GUIDANCE, "utf-8")) as {
      body: string;
    };
    expect(topic.body).toMatch(/npm install --save-dev @memex-ai-ac\/vitest/);
    expect(topic.body).toMatch(/@memex-ai-ac\/vitest\/setup/);
    // ac-7: no curl strings referring to a template URL.
    // Surviving mention of curl in the topic body is fine ONLY if it
    // doesn't point at /install/ac-emit-vitest.ts (we kept the curl-route
    // anti-example in the doc since the safety lesson still applies).
    expect(topic.body).not.toMatch(/curl[^\n]*\/install\/ac-emit-vitest/i);
  });

  it("this regression test asserts against the single workspace package source (no template-vs-dogfood loop) [spec-89 ac-8]", () => {
    tagAc(`${SPEC_89}/ac-8`);
    const self = readFileSync(THIS_FILE, "utf-8");
    // Post spec-89: a single HELPER_SOURCE pointing at the workspace package.
    // The previous shape (deleted by this spec) had path constants for the
    // bootstrap template AND a dogfood copy, and looped over both.
    expect(self).not.toMatch(/server.*bootstrap.*ac-emit-vitest\.ts/);
    expect(self).not.toMatch(
      /for\s*\(\s*const\s*\[\s*label\s*,\s*path\s*\]\s+of/,
    );
    expect(self).toMatch(
      /packages.*ac-emit-vitest.*src.*derive-url/,
    );
  });
});
