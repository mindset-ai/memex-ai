// spec-304: the desktop client ships from its own repo, NOT the memex-ai pnpm
// workspace. This guards the in-repo, falsifiable half of that boundary:
//   - ac-24: "...absent from the memex-ai pnpm-workspace.yaml packages glob."
//   - ac-14: "...independent of the memex-ai pnpm workspace..." (the
//            workspace-independence clause; the "ships from
//            github.com/mindset-ai/memex-clients with its own build/CI/release
//            pipeline" clause is confirmed live via the git remote + branch
//            protection, recorded in the Spec's QA report).
//
// The regression this catches: someone vendoring the Flutter desktop client in
// as a workspace package (a `packages/*` dir carrying a pubspec.yaml), which
// would re-couple the client to this workspace.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-304/acs/ac-${n}`;

/** Walk up from this file until the repo root (the dir with pnpm-workspace.yaml). */
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("pnpm-workspace.yaml not found walking up from the test file");
}

/** Extract the `- "<glob>"` entries under the top-level `packages:` key. */
function workspacePackageGlobs(yaml: string): string[] {
  const globs: string[] = [];
  let inPackages = false;
  for (const raw of yaml.split(/\r?\n/)) {
    if (/^packages:\s*$/.test(raw)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      // A non-indented, non-empty line ends the packages block.
      if (raw.trim() !== "" && !/^\s/.test(raw)) break;
      const m = raw.match(/^\s*-\s*["']?(.+?)["']?\s*$/);
      if (m) globs.push(m[1]);
    }
  }
  return globs;
}

describe("workspace boundary — desktop client is not a memex-ai package (spec-304)", () => {
  const root = findRepoRoot();

  it("pnpm-workspace.yaml only globs packages/* — nothing outside packages/", () => {
    tagAc(AC(24));
    tagAc(AC(14));
    const yaml = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
    const globs = workspacePackageGlobs(yaml);

    expect(globs.length).toBeGreaterThan(0);
    // Every workspace glob must be confined under packages/ — so a sibling repo
    // checked out alongside (e.g. memex-clients) can never be a workspace member.
    for (const glob of globs) {
      expect(glob.startsWith("packages/")).toBe(true);
    }
  });

  it("no packages/* dir carries a pubspec.yaml (the Flutter desktop client is not vendored)", () => {
    tagAc(AC(24));
    const packagesDir = join(root, "packages");
    const entries = readdirSync(packagesDir, { withFileTypes: true });
    const flutterPkgs = entries
      .filter((e) => e.isDirectory())
      .filter((e) => existsSync(join(packagesDir, e.name, "pubspec.yaml")))
      .map((e) => e.name);

    expect(flutterPkgs).toEqual([]);
    // And specifically no desktop-client package by name.
    expect(entries.some((e) => e.name === "memex-clients")).toBe(false);
  });
});
