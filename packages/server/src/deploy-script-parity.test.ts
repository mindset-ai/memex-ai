// spec-515 — every pnpm script deploy.sh invokes must actually exist.
//
// WHY THIS EXISTS. The reserved-root collision gate (t-3) was wired into deploy.sh
// as `pnpm --filter @memex/server tsx scripts/check-reserved-root-collisions.ts`.
// pnpm reads the token after the filter as a SCRIPT NAME, not a binary, so it died
// with ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT. Because that gate is deliberately
// fail-closed ("could not check" == "did not pass"), the broken invocation aborted
// the entire int deploy on the first run that ever exercised it — 2026-08-10,
// three weeks after the script itself was written and unit-tested.
//
// The unit tests proved the script's LOGIC. Nothing proved it could be REACHED,
// because the only thing that runs deploy.sh is a deploy. That is the whole gap:
// implemented is not activated, and a deploy step is the one kind of code whose
// call site never runs in CI.
//
// This test closes it statically, with no database and no network: parse the real
// deploy.sh, extract every pnpm script invocation, and assert each one resolves in
// the package.json it would run against. A typo'd or renamed script now reddens a
// PR instead of stranding a deploy.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";

const PKG_DIR = join(import.meta.dirname, "..");
const REPO_ROOT = join(PKG_DIR, "..", "..");

// deploy.sh `cd "${PKG_DIR}"` at the top (line ~22), so a bare `pnpm <script>`
// resolves against packages/server. An explicit `--filter <pkg>` overrides that.
const DEFAULT_PKG = "@memex/server";

// pnpm subcommands that are NOT script names — the token after them is an
// argument, so there is nothing to look up.
const PNPM_SUBCOMMANDS = new Set([
  "exec",
  "dlx",
  "install",
  "add",
  "remove",
  "why",
  "list",
  "config",
  "publish",
  "pack",
  "store",
  "prune",
  "rebuild",
  "deploy",
  "licenses",
  "audit",
  "outdated",
  "update",
]);

type Invocation = { line: number; pkg: string; script: string; raw: string };

/**
 * Pull every pnpm script invocation out of a shell script.
 *
 * Comment lines are skipped, which is load-bearing rather than tidiness: the fix
 * for this very defect left a comment in deploy.sh quoting the BROKEN command as
 * a warning to the next reader. A scanner that read comments would flag that
 * warning as the defect it warns about — and the cheapest way to silence it would
 * be to delete the explanation.
 */
export function parsePnpmScriptInvocations(shell: string): Invocation[] {
  const out: Invocation[] = [];

  shell.split("\n").forEach((rawLine, i) => {
    const line = rawLine.trim();
    if (line.startsWith("#") || line === "") return;

    // `pnpm [--filter <pkg>] [run] <script>` — capture the filter and the token
    // that lands in script position.
    const re = /\bpnpm\s+(?:--filter\s+(\S+)\s+)?(?:run\s+)?([A-Za-z0-9:_-]+)/g;
    for (const m of line.matchAll(re)) {
      const pkg = m[1] ?? DEFAULT_PKG;
      const script = m[2];
      if (PNPM_SUBCOMMANDS.has(script)) continue;
      // A flag in script position means the invocation is something else.
      if (script.startsWith("-")) continue;
      out.push({ line: i + 1, pkg, script, raw: line });
    }
  });

  return out;
}

function scriptsFor(pkgName: string): Record<string, string> {
  // The two packages deploy.sh can name today. Resolved by name rather than by
  // globbing the workspace so an unexpected package is a loud failure.
  const dirByName: Record<string, string> = {
    "@memex/server": join(REPO_ROOT, "packages", "server"),
    "@memex/ui": join(REPO_ROOT, "packages", "ui"),
    "@memex/shared": join(REPO_ROOT, "packages", "shared"),
  };
  const dir = dirByName[pkgName];
  if (!dir) throw new Error(`deploy.sh names an unmapped package: ${pkgName}`);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  return pkg.scripts ?? {};
}

describe("deploy.sh pnpm script parity (spec-515)", () => {
  const shell = readFileSync(join(PKG_DIR, "deploy.sh"), "utf8");
  const invocations = parsePnpmScriptInvocations(shell);

  it("finds the invocations at all — an empty scan would pass vacuously", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-515/acs/ac-4");
    expect(invocations.length).toBeGreaterThan(3);
  });

  it("every script deploy.sh invokes exists in its package", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-515/acs/ac-4");

    const missing = invocations
      .filter((inv) => !(inv.script in scriptsFor(inv.pkg)))
      // Named, not counted, so the failure says WHICH line and WHICH script.
      .map((inv) => `deploy.sh:${inv.line} → ${inv.pkg} has no script "${inv.script}"`);

    expect(missing).toEqual([]);
  });

  it("the reserved-root gate specifically resolves — the one that broke the deploy", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-515/acs/ac-4");

    const gate = invocations.find((inv) => inv.script === "check-reserved-roots");
    expect(gate, "deploy.sh no longer invokes check-reserved-roots").toBeDefined();
    expect(scriptsFor(gate!.pkg)).toHaveProperty("check-reserved-roots");
  });

  it("skips commented-out invocations, so an explanatory comment cannot redden this", () => {
    const parsed = parsePnpmScriptInvocations(
      ["# pnpm --filter @memex/server tsx scripts/whatever.ts", "pnpm db:migrate"].join("\n"),
    );
    expect(parsed.map((p) => p.script)).toEqual(["db:migrate"]);
  });
});
