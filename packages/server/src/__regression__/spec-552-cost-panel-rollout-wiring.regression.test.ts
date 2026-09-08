// spec-552 t-2 (dec-8), ac-20 — the rollout gate reaches the running revision.
//
// WHY THIS EXISTS. `COST_PANEL_MEMEXES` is the only part of spec-552 whose
// failure is completely silent. It travels FOUR links:
//
//   1. a GitHub Environment variable (per env: "*" on int, the dogfood ref on prod)
//   2. .github/workflows/deploy.yml    — into the deploy step's env
//   3. scripts/deploy-config.sh        — a set-vs-unset export
//   4. packages/server/deploy.sh       — ${VAR+|VAR=...} onto the Cloud Run revision
//
// Break link 2 or 3 and the next unrelated deploy CLEARS a hand-set rollout —
// spec-510 dec-6's "switch that looks armed and is not". Break link 4 and the
// value never reaches the server at all: the panel stays dark in prod, no error
// anywhere, and the obvious diagnosis (a wrong allowlist) is wrong.
//
// The plan for this task said three links. Link 4 was found by reading
// deploy.sh, which is why the assertion covers the chain rather than the two
// files the plan named — a source scan is the right evidence for a wiring
// claim, and it is the only evidence available before a real deploy.
//
// Link 1 lives in GitHub's UI and cannot be asserted from the repo. It is
// verified post-deploy by reading the value back off the running revision
// (spec-552 t-6), never inferred from the config that was pushed.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-552/acs/ac-${n}`;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../../..");

function read(relative: string): string {
  return readFileSync(join(repoRoot, relative), "utf8");
}

const VAR = "COST_PANEL_MEMEXES";

describe("spec-552 ac-20: COST_PANEL_MEMEXES survives a deploy", () => {
  it("link 2 — deploy.yml passes the GitHub Environment variable into the deploy step", () => {
    tagAc(AC(20));
    const yml = read(".github/workflows/deploy.yml");
    // Mirrors the ACTIVATION_EMAILS_ENABLED line: a per-environment variable,
    // not a secret, so it can be flipped from the GitHub environment UI.
    expect(yml).toContain(`${VAR}: \${{ vars.${VAR} }}`);
  });

  it("link 3 — deploy-config.sh forwards it on set-vs-unset, never on its value", () => {
    tagAc(AC(20));
    const sh = read("scripts/deploy-config.sh");
    // `${VAR+set}` (set-vs-unset), NOT `${VAR:-}` or `-n "$VAR"` (value tests):
    // the distinction is the whole point. A value test treats "not configured
    // here" and "configured empty" identically, and clearing a live rollout is
    // exactly what must not happen by accident.
    expect(sh).toContain(`if [ -n "\${${VAR}+set}" ]; then`);
    expect(sh).toContain(`  export ${VAR}`);
  });

  it("link 4 — deploy.sh puts it on the Cloud Run revision, and only when set", () => {
    tagAc(AC(20));
    const sh = read("packages/server/deploy.sh");
    // The optional-expansion form: present in --update-env-vars only when the
    // variable is set, so an unset value is omitted rather than pushed empty.
    expect(sh).toContain(`\${${VAR}+|${VAR}=\${${VAR}}}`);
    // And it must be inside the --update-env-vars ARGUMENT, not merely
    // mentioned in a comment somewhere in the file.
    //
    // Match the argument line, not any line containing the flag name: deploy.sh
    // has two comments above it (`:439`, `:442`) that discuss --update-env-vars
    // in prose, and a naive `.find()` returns the first of those and asserts
    // nothing. Source-scan guards have to exclude comments or they pass on the
    // wrong text — the same trap the t-1 migration guard hit with "default".
    const argumentLine = sh
      .split("\n")
      .find((line) => /^\s*--update-env-vars\b/.test(line));
    expect(argumentLine).toBeDefined();
    expect(argumentLine).toContain(VAR);
  });

  it("the chain has no gap — every in-repo link carries the same variable name", () => {
    tagAc(AC(20));
    // One assertion over the whole chain, so a rename that updates two files
    // and forgets the third goes red rather than shipping a dead flag.
    const links = [
      ".github/workflows/deploy.yml",
      "scripts/deploy-config.sh",
      "packages/server/deploy.sh",
    ];
    const missing = links.filter((path) => !read(path).includes(VAR));
    expect(missing).toEqual([]);
  });
});
