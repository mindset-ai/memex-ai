import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// @ts-expect-error — plain .mjs module, no types needed for a test.
import { computeSchemaHash, decidePublish, bumpPatch } from "../scripts/publish-guard.mjs";

// spec-279 t-2 — the GitHub Actions publish workflow + its guard logic.

const WORKFLOW_PATH = resolve(__dirname, "..", "..", "..", ".github", "workflows", "publish-db-schema.yml");
const workflow = readFileSync(WORKFLOW_PATH, "utf8");
const pkgJson = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf8"));

describe("ac-8 — publishes to GitHub Packages authenticating with GITHUB_TOKEN only", () => {
  it("targets the @mindset-ai GitHub Packages registry and references no secret but GITHUB_TOKEN", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-279/acs/ac-8");

    // Right registry + scope.
    expect(workflow).toContain("https://npm.pkg.github.com");
    expect(workflow).toContain('scope: "@mindset-ai"');

    // Auth is wired to the built-in token via NODE_AUTH_TOKEN.
    expect(workflow).toMatch(/NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/);

    // The ONLY secret referenced anywhere is GITHUB_TOKEN — no PAT / NPM_TOKEN / org secret.
    const secretsUsed = new Set([...workflow.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]));
    expect([...secretsUsed]).toEqual(["GITHUB_TOKEN"]);

    // And the package itself is configured to publish to that registry.
    expect(pkgJson.publishConfig?.registry).toBe("https://npm.pkg.github.com");
  });
});

describe("ac-9 — no-op guard: unchanged schema produces no new version", () => {
  it("decidePublish skips when the published hash matches, publishes otherwise", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-279/acs/ac-9");

    const currentHash = "abc123def456";

    // Two consecutive runs with the same schema → second run does not publish.
    expect(decidePublish({ publishedHash: currentHash, currentHash }).publish).toBe(false);

    // Changed schema → publish.
    expect(decidePublish({ publishedHash: "0000deadbeef", currentHash }).publish).toBe(true);

    // Never published before → first publish.
    expect(decidePublish({ publishedHash: null, currentHash }).publish).toBe(true);
  });

  it("computeSchemaHash is deterministic and content-sensitive", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-279/acs/ac-9");

    const a = computeSchemaHash("export const documents = pgTable('documents', {});");
    const b = computeSchemaHash("export const documents = pgTable('documents', {});");
    const c = computeSchemaHash("export const acs = pgTable('acs', {});");
    expect(a).toBe(b); // same input → same hash
    expect(a).not.toBe(c); // different input → different hash
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("ac-2 — fires on the release line and publishes a pinnable, claimable version", () => {
  it("triggers on push to main + workflow_dispatch and runs the publish script", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-279/acs/ac-2");

    expect(workflow).toMatch(/branches:\s*\[main\]/);
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("packages/db-schema/scripts/publish.mjs");
  });

  it("uses a claimable scoped name (NOT @memex) and bumps to a valid pinnable semver", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-279/acs/ac-2");

    // Name is the claimable @mindset-ai scope, not the unavailable @memex (spec-89).
    expect(pkgJson.name).toBe("@mindset-ai/db-schema");
    expect(pkgJson.name.startsWith("@memex/")).toBe(false);

    // The version the script publishes is an exact, pinnable semver.
    expect(bumpPatch("0.1.0")).toBe("0.1.1");
    expect(bumpPatch("0.1.9")).toBe("0.1.10");
    expect(() => bumpPatch("not-semver")).toThrow();
    expect(pkgJson.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
