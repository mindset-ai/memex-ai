// spec-544 ac-10 — `make check` must stay offline after this work.
//
// WHY THIS GUARD EXISTS. spec-544 gave the generator a network mode, and the
// tempting "improvement" is to make `--check` consult the live list too, so the
// offline check can catch a drifted manifest. That would be wrong twice over:
// `make check` is the sub-minute lane that replaces push-and-wait (no DB, no
// network), and a PR must never go red because a network call was unavailable.
// dec-3 put the live comparison in a separate, non-required job precisely so the
// merge path never depends on prod being up.
//
// WHAT THIS PROVES, AND WHAT IT DOES NOT. These are STRUCTURAL guards over the
// source and the Makefile — the same idiom the repo already uses for the std-8
// mutate scan and the std-30 no-direct-anthropic guard. They prove that `fetch`
// is reachable only from the one online function and that `standards-check` never
// asks for the online mode. They do NOT prove the process opens no socket at all;
// a transitive dependency could in principle. That stronger claim needs a
// sandboxed run with the network removed, which is the CI environment's job, not
// a unit test's. Stated plainly rather than overclaimed.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";

const AC10 = "mindset-prod/memex-building-itself/specs/spec-544/acs/ac-10";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const SCRIPT = readFileSync(
  join(REPO_ROOT, "scripts", "ci", "standards-index.mjs"),
  "utf8",
);
const MAKEFILE = readFileSync(join(REPO_ROOT, "Makefile"), "utf8");

/** The body of a top-level `function name(...)` / `async function name(...)`.
 *
 *  Skips the PARAMETER LIST first, by paren matching, before brace matching the
 *  body — a destructured parameter (`function sync({ repo, root })`) opens a brace
 *  of its own, and starting at the first `{` after the name returns `{ repo, root }`
 *  instead of the function. That mistake made this file's own guard pass against
 *  a two-word string, so it is fixed here rather than worked around. */
function functionBody(source: string, name: string): string {
  const decl = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const at = source.search(decl);
  expect(at, `${name}() must exist in standards-index.mjs`).toBeGreaterThan(-1);

  // Walk the parameter list to its closing paren.
  const parenOpen = source.indexOf("(", at);
  let parens = 0;
  let bodyStart = -1;
  for (let i = parenOpen; i < source.length; i++) {
    if (source[i] === "(") parens++;
    else if (source[i] === ")") {
      parens--;
      if (parens === 0) {
        bodyStart = source.indexOf("{", i);
        break;
      }
    }
  }
  expect(bodyStart, `could not find the body of ${name}()`).toBeGreaterThan(-1);

  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(bodyStart, i + 1);
    }
  }
  throw new Error(`unbalanced braces reading ${name}()`);
}

describe("spec-544: the offline check never reaches the network (ac-10)", () => {
  it("fetch( is called from exactly ONE function, the online edge", () => {
    tagAc(AC10);

    // Denominator: if this regex stops matching, every assertion below is vacuous.
    const callSites = [...SCRIPT.matchAll(/(?<![.\w])fetch\s*\(/g)];
    expect(
      callSites.length,
      "No `fetch(` call site found at all — the regex has broken, which would make " +
        "the containment assertion below pass against nothing.",
    ).toBeGreaterThan(0);

    const edge = functionBody(SCRIPT, "fetchLiveStandards");
    const outside = callSites.filter((m) => !edge.includes(SCRIPT.slice(m.index!, m.index! + 8)));

    // Positive containment: the one call site lives in the online edge.
    expect(edge, "fetchLiveStandards is the network edge and must hold the call").toMatch(
      /(?<![.\w])fetch\s*\(/,
    );
    expect(
      callSites.length,
      `Expected exactly one \`fetch(\` in the generator; found ${callSites.length}. ` +
        `A second call site means the network has leaked out of fetchLiveStandards — ` +
        `and the offline lane is one refactor away from needing it. Found ${outside.length} ` +
        `outside the edge.`,
    ).toBe(1);
  });

  it("the check path never calls the online edge", () => {
    tagAc(AC10);

    // main() may only reach fetchLiveStandards THROUGH sync(), and sync() may only
    // run in the 'sync' mode. If main called the edge directly, --check would be
    // online regardless of mode.
    const main = functionBody(SCRIPT, "main");
    expect(
      main,
      "main() must not call fetchLiveStandards directly — it goes through sync(), " +
        "which only runs in the online mode.",
    ).not.toMatch(/fetchLiveStandards\s*\(/);
    expect(
      main,
      "sync() must be gated on the mode, so --check and --write cannot reach it.",
    ).toMatch(/mode\s*===\s*["']sync["']/);

    const sync = functionBody(SCRIPT, "sync");
    expect(sync, "sync() is the only caller of the online edge").toMatch(
      /fetchLiveStandards\s*\(/,
    );
  });

  it("make standards-check asks for the offline mode, and make check depends on it", () => {
    tagAc(AC10);

    const target = MAKEFILE.split(/^standards-check:/m)[1] ?? "";
    expect(target, "the standards-check target must exist").not.toBe("");
    const recipe = target.split(/\n(?=\S)/)[0];

    expect(recipe, "standards-check must run the offline --check mode").toContain("--check");
    expect(
      recipe,
      "standards-check must NEVER pass --sync — that is the online mode, and " +
        "`make check` is the no-network lane.",
    ).not.toContain("--sync");
    expect(
      recipe,
      "The check is per-repo now, and --repo is required — a target without it " +
        "would fail at parse time rather than checking anything.",
    ).toContain("--repo");

    // And the offline battery still includes it (spec-512 dec-4's original point).
    const checkTarget = MAKEFILE.split(/^check:/m)[1]?.split("\n")[0] ?? "";
    expect(
      checkTarget,
      "`make check` must still run standards-check, or a stale index goes unnoticed.",
    ).toContain("standards-check");
  });

  it("standards-sync is the ONLY target that asks for the network", () => {
    tagAc(AC10);

    const syncTargets = [...MAKEFILE.matchAll(/^([a-z-]+):[^\n]*\n((?:\t[^\n]*\n)+)/gm)]
      .filter(([, , recipe]) => recipe.includes("--sync"))
      .map(([, name]) => name);

    expect(
      syncTargets,
      "Exactly one Make target may request the online mode. Any other target " +
        "carrying --sync would drag the network into a lane that must not need it.",
    ).toEqual(["standards-sync"]);
  });
});
