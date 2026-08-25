import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";

// spec-539 t-1 — the e2e emitter's payload.
//
// This file is the monorepo's only unit test under e2e/ (dec-3): the emitter is
// e2e-only code whose behaviour is worth testing without booting Playwright, and the
// alternative was moving runtime code into src/ purely for testability.
//
// The claim that matters most is NEGATIVE. ac-10 exists because the obvious-looking
// call — buildMetadata(process.env) — merges the ENTIRE environment into the payload,
// and test_events metadata is world-readable on a public Memex [per std-31]. A test
// that only checked "run_id is present" would have passed that mistake.
const SPEC = "mindset-prod/memex-building-itself/specs/spec-539";
const AC_IMPORTS = `${SPEC}/acs/ac-6`;   // provenance comes from the imported builder
const AC_BOTH_ENVS = `${SPEC}/acs/ac-7`; // CI env → run_id; bare env → none, still emits
const AC_NO_LEAK = `${SPEC}/acs/ac-10`;  // metadata never carries arbitrary env vars
const AC_WIRED = `${SPEC}/acs/ac-11`;    // this file is actually picked up by vitest

const HERE = dirname(fileURLToPath(import.meta.url));

/** Capture what emitAcEvents POSTs, without letting a request leave the process. */
function captureFetch() {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const spy = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return new Response("{}", { status: 200 });
  });
  vi.stubGlobal("fetch", spy);
  return calls;
}

const AC_UNDER_TEST = "mindset-prod/memex-building-itself/specs/spec-1/acs/ac-1";

afterEach(() => {
  // std-37 cl-5: restore every global and env this file replaced, or a sibling
  // inherits a stubbed fetch and its emissions vanish.
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function emitOnce() {
  const { emitAcEvents } = await import("./emit-ac.js");
  await emitAcEvents([AC_UNDER_TEST], "pass", "unit/emit-ac.test.ts", 1);
}

describe("spec-539: the e2e emitter carries honest CI provenance", () => {
  it("is picked up by packages/ui's vitest run at all", () => {
    tagAc(AC_WIRED);
    // Vacuous-looking on purpose: if the include entry is ever dropped, this file
    // stops running and every other assertion here goes silently missing rather
    // than red. This is the canary for that.
    expect(true).toBe(true);

    const config = readFileSync(join(HERE, "..", "..", "vitest.config.ts"), "utf8");
    expect(config).toContain("e2e/helpers/**/*.test.ts");
    // dec-3 obligation 1: the convention break is explained, not silent.
    const line = config
      .split("\n")
      .findIndex((l) => l.includes("e2e/helpers/**/*.test.ts"));
    const preceding = config.split("\n").slice(Math.max(0, line - 6), line).join("\n");
    expect(preceding).toMatch(/spec-539|e2e-only|dec-3/);
  });

  it("derives provenance from the imported builder, not from a second hand-rolled copy", async () => {
    tagAc(AC_IMPORTS);
    const src = readFileSync(join(HERE, "emit-ac.ts"), "utf8");

    expect(src).toMatch(/import\s*\{[^}]*buildMetadata[^}]*\}\s*from\s*["']@memex-ai-ac\/vitest["']/);
    // No second derivation: the GitHub env vars belong to buildMetadata alone.
    for (const envVar of ["GITHUB_RUN_ID", "GITHUB_SHA", "GITHUB_REF_NAME", "GITHUB_HEAD_REF", "GITHUB_SERVER_URL"]) {
      expect(src, `${envVar} must be read by buildMetadata, not here`).not.toContain(envVar);
    }
  });

  it("attaches run_id and run_url under a GitHub Actions environment", async () => {
    tagAc(AC_BOTH_ENVS);
    vi.stubEnv("MEMEX_EMIT_KEY", "mxk_test");
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.stubEnv("GITHUB_RUN_ID", "42424242");
    vi.stubEnv("GITHUB_SERVER_URL", "https://github.com");
    vi.stubEnv("GITHUB_REPOSITORY", "mindset-ai/memex-ai");
    vi.stubEnv("GITHUB_SHA", "deadbeef");
    const calls = captureFetch();

    await emitOnce();

    expect(calls).toHaveLength(1);
    const md = calls[0].body.metadata as Record<string, string>;
    expect(md.run_id).toBe("42424242");
    expect(md.run_url).toBe("https://github.com/mindset-ai/memex-ai/actions/runs/42424242");
    expect(md.commit).toBe("deadbeef");
    expect(md.host).toBe("ci");
  });

  it("emits with no run_id under a bare local environment — provenance added, never faked", async () => {
    tagAc(AC_BOTH_ENVS);
    // scope ac-2: the anti-cheat. A fix that fabricated CI attribution to silence the
    // audit's warning would be worse than the warning — this is what forbids it.
    tagAc(`${SPEC}/acs/ac-2`);
    vi.stubEnv("MEMEX_EMIT_KEY", "mxk_test");
    // Explicitly absent rather than un-stubbed: this test must not read whatever
    // the developer's machine happens to export — the exact defect dec-2 is fixing
    // two files down the repo.
    vi.stubEnv("GITHUB_ACTIONS", "");
    vi.stubEnv("GITHUB_RUN_ID", "");
    vi.stubEnv("CI", "");
    const calls = captureFetch();

    await emitOnce();

    // Still emitted — a local run is recorded, just not dressed up as CI.
    expect(calls).toHaveLength(1);
    const md = (calls[0].body.metadata ?? {}) as Record<string, string>;
    expect(md.run_id).toBeUndefined();
    expect(md.run_url).toBeUndefined();
  });

  it("never puts an arbitrary environment variable in metadata", async () => {
    tagAc(AC_NO_LEAK);
    vi.stubEnv("MEMEX_EMIT_KEY", "mxk_test");
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.stubEnv("GITHUB_RUN_ID", "1");
    // A secret-shaped variable of exactly the kind a developer shell carries.
    vi.stubEnv("GITTOKEN", "ghp_this_must_never_be_published");
    const calls = captureFetch();

    await emitOnce();

    const md = (calls[0].body.metadata ?? {}) as Record<string, string>;
    // Guard against passing vacuously: if metadata were absent entirely, the key-set
    // loop below would iterate zero times and this test would prove nothing.
    expect(md.run_id, "metadata must actually be populated for this check to mean anything").toBe("1");
    // The allowed set is what the helper derives itself, plus MEMEX_METADATA_* keys.
    const WELL_KNOWN = new Set(["branch", "commit", "host", "run_id", "run_url"]);
    for (const key of Object.keys(md)) {
      expect(WELL_KNOWN.has(key), `unexpected metadata key "${key}" — is process.env being passed to buildMetadata?`).toBe(true);
    }
    expect(JSON.stringify(calls[0].body)).not.toContain("ghp_this_must_never_be_published");
    expect(Object.keys(md)).not.toContain("GITTOKEN");
  });
});
