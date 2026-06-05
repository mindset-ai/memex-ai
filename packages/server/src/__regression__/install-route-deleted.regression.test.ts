// spec-89 v0.1.0 dec-1 + ac-5 + ac-6 — the legacy /install/ac-emit-vitest.ts
// route and its bootstrap helper source are deleted. External adopters now
// install via `npm install --save-dev @memex-ai-ac/vitest`; the curl-based
// template install is gone.
//
// Verified at source level rather than runtime because constructing the full
// app.ts in a test requires DB + middleware wiring the regression test
// doesn't need. The structural assertion is the right contract: if the
// handler is absent from app.ts and the source file is gone, the route is
// gone.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";

const SPEC_89 = "mindset-prod/memex-building-itself/specs/spec-89/acs";

const SERVER_ROOT = join(__dirname, "..", "..");
const APP_TS = join(SERVER_ROOT, "src", "app.ts");
const BOOTSTRAP_DIR = join(SERVER_ROOT, "bootstrap");

describe("spec-89 ac-5 / ac-6 — /install/ac-emit-vitest.ts route deleted", () => {
  it("app.ts no longer registers an /install/ac-emit-vitest.ts handler [spec-89 ac-6]", () => {
    tagAc(`${SPEC_89}/ac-6`);
    const src = readFileSync(APP_TS, "utf-8");
    // The pre-spec-89 shape: app.get("/install/ac-emit-vitest.ts", ...).
    // Hono's default behaviour for an unregistered route is a 404 response.
    expect(src).not.toMatch(/app\.get\(\s*["']\/install\/ac-emit-vitest\.ts["']/);
  });

  it("app.ts no longer references the cached helper source variable [spec-89 ac-6]", () => {
    tagAc(`${SPEC_89}/ac-6`);
    const src = readFileSync(APP_TS, "utf-8");
    expect(src).not.toMatch(/cachedAcEmitVitest/);
  });

  it("the helper source file is no longer present in packages/server/bootstrap [spec-89 ac-6]", () => {
    tagAc(`${SPEC_89}/ac-6`);
    expect(existsSync(join(BOOTSTRAP_DIR, "ac-emit-vitest.ts"))).toBe(false);
  });

  it("bootstrap/ remains for the OAuth/CLI install scripts (not affected by this spec) [spec-89 ac-5]", () => {
    // ac-5 read positively: nothing is silently broken. The bootstrap dir
    // still holds install.sh / install.ps1, which power /install.sh and
    // /install.ps1 (unrelated to the AC emit helper, used by the OAuth CLI
    // bootstrap flow). Those routes survive.
    tagAc(`${SPEC_89}/ac-5`);
    expect(existsSync(BOOTSTRAP_DIR)).toBe(true);
    const entries = readdirSync(BOOTSTRAP_DIR);
    expect(entries).toContain("install.sh");
    expect(entries).toContain("install.ps1");
    expect(entries).not.toContain("ac-emit-vitest.ts");
  });

  it("ac-emission guidance topic provides a replacement install path [spec-89 ac-5]", () => {
    // ac-5 second clause: not silently broken. The guidance topic
    // documents the npm install path so external readers landing on the
    // topic via Memex public access see the new canonical install.
    tagAc(`${SPEC_89}/ac-5`);
    const GUIDANCE = join(SERVER_ROOT, "src", "guidance", "ac-emission.json");
    const topic = JSON.parse(readFileSync(GUIDANCE, "utf-8")) as {
      body: string;
    };
    expect(topic.body).toMatch(/npm install --save-dev @memex-ai-ac\/vitest/);
  });
});
