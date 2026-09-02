// spec-544 — the drift job's shape is load-bearing, so it is pinned.
//
// Three properties, each with a failure mode that is INVISIBLE at 3am if it
// regresses:
//
//   ac-11 — triggers on `push: develop` as well as `schedule:`, and is not a
//           required check. GitHub skips scheduled runs under load and disables
//           them entirely in a public repo after 60 days of no commits; a job
//           that only fires on a timer can stop without anyone noticing. And a
//           REQUIRED check calling memex.ai would couple every merge to prod
//           uptime, with enforce_admins leaving no bypass.
//   ac-22 — no cross-repo credential. The whole point of dec-6 is that each repo
//           opens its own PR with its own repo-scoped token, so the first PAT in
//           this repo never gets minted.
//   ac-23 — the set-diff exists once. If the caller ever grows its own copy of
//           the comparison, memex-clients starts drifting from memex-ai again.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-544/acs/ac-${n}`;

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const WORKFLOW_DIR = join(REPO_ROOT, ".github", "workflows");
const ACTION_DIR = join(REPO_ROOT, ".github", "actions", "standards-index");

const WORKFLOW = readFileSync(join(WORKFLOW_DIR, "standards-drift.yml"), "utf8");
const ACTION = readFileSync(join(ACTION_DIR, "action.yml"), "utf8");

describe("spec-544: the drift job fires on merges, not only on a timer (ac-11)", () => {
  it("triggers on push to develop AND on a schedule", () => {
    tagAc(AC(11));

    expect(
      WORKFLOW,
      "A schedule-only job can stop silently: GitHub skips scheduled runs under " +
        "load, and auto-disables them in a PUBLIC repo after 60 days without " +
        "commits. `push: develop` is what makes a broken job a visible red.",
    ).toMatch(/push:\s*\n\s*branches:\s*\[develop\]/);
    expect(WORKFLOW, "the schedule stays as the net for quiet periods").toMatch(
      /schedule:\s*\n(?:\s*#[^\n]*\n)*\s*- cron:/,
    );
  });

  it("does not contend with the nightly perf run's slot", () => {
    tagAc(AC(11));

    const perf = readFileSync(join(WORKFLOW_DIR, "test.yml"), "utf8");
    const slot = (src: string) => src.match(/- cron:\s*"([^"]+)"/)?.[1];
    expect(slot(WORKFLOW)).toBeDefined();
    expect(
      slot(WORKFLOW),
      "Sharing test.yml's cron slot would put a network job and the perf run on " +
        "the same runners at the same minute for no reason.",
    ).not.toBe(slot(perf));
  });

  it("is absent from every required-check aggregate", () => {
    tagAc(AC(11));

    // Nothing in this repo may name the drift job as a gate. Branch protection
    // itself lives on GitHub and cannot be read from here — stated rather than
    // implied: this pins the REPO side, and the protection settings stay a manual
    // check. What it does catch is the realistic regression, someone wiring the
    // job into an existing aggregate.
    for (const file of readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith(".yml"))) {
      if (file === "standards-drift.yml") continue;
      const src = readFileSync(join(WORKFLOW_DIR, file), "utf8");
      expect(
        src,
        `${file} must not depend on the standards drift job — making it a gate would ` +
          `couple merges to memex.ai's availability, and enforce_admins leaves no bypass.`,
      ).not.toMatch(/standards-drift/);
    }
  });
});

describe("spec-544: no cross-repo credential (ac-22)", () => {
  it("the caller passes only its own GITHUB_TOKEN", () => {
    tagAc(AC(22));

    expect(WORKFLOW).toMatch(/token:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/);

    // The realistic regression: someone hits the cross-repo wall and reaches for
    // a PAT or an App. Both are refused here by name.
    const secretsUsed = [...WORKFLOW.matchAll(/secrets\.([A-Z_][A-Z0-9_]*)/g)].map(
      (m) => m[1],
    );
    expect(
      secretsUsed,
      "The drift job must use NOTHING but the automatic token. A PAT is tied to a " +
        "person and expires silently — the failure dec-3 spent its resolution " +
        "designing out.",
    ).toEqual(["GITHUB_TOKEN"]);

    // Match credential USAGE, not the words. The action's own comments explain
    // why a PAT and a GitHub App were rejected, and prose that argues against a
    // thing must not trip a guard against using it — otherwise the guard
    // pressures the next author into deleting the reasoning.
    const usage = [
      /secrets\.[A-Z_]*(?:PAT|TOKEN_[A-Z]|APP_ID|PRIVATE_KEY)/,
      /create-github-app-token/,
      /actions\/create-github-app-token/,
    ];
    for (const forbidden of usage) {
      expect(ACTION, `the action must not USE ${forbidden}`).not.toMatch(forbidden);
      expect(WORKFLOW, `the caller must not USE ${forbidden}`).not.toMatch(forbidden);
    }

    // A composite action cannot read `secrets` at all — it receives the token as
    // an input. Any `secrets.` reference in it is a sign someone tried.
    expect(
      ACTION,
      "The action takes the token as an INPUT; reaching for `secrets` inside it " +
        "would mean a credential was wired somewhere it cannot work.",
    ).not.toMatch(/\$\{\{\s*secrets\./);
  });

  it("permissions are least-privilege and scoped to the job", () => {
    tagAc(AC(22));

    // Root stays read-only; the write grants sit on the one job that needs them.
    expect(WORKFLOW).toMatch(/^permissions:\s*\n\s*contents: read\s*$/m);
    expect(WORKFLOW).toMatch(/contents: write/);
    expect(
      WORKFLOW,
      "First use of `pull-requests` in this repo — it belongs on the job, not the root.",
    ).toMatch(/pull-requests: write/);
  });
});

describe("spec-544: the set-diff is written once (ac-23)", () => {
  it("the caller delegates to the shared action and implements nothing", () => {
    tagAc(AC(23));

    expect(WORKFLOW).toMatch(/uses:\s*\.\/\.github\/actions\/standards-index/);
    expect(
      WORKFLOW,
      "The caller must not run the generator itself — a second invocation path is " +
        "a second thing to keep in step with memex-clients.",
    ).not.toMatch(/standards-index\.mjs/);
    expect(WORKFLOW, "and must not reimplement the comparison").not.toMatch(
      /planIndex|fetchLiveStandards|type=standard/,
    );
  });

  it("the action's relative path to the generator actually resolves", () => {
    tagAc(AC(23));

    // The action runs inside the memex-ai checkout GitHub fetches for `uses:`,
    // and reaches the script three levels up from its own directory. That string
    // is the one thing a layout move would break — and it would break at 3am in
    // ANOTHER repo's workflow run, where nobody is looking. Pin it here, in
    // memex-ai's own suite, where a move goes red immediately.
    const relative = ACTION.match(
      /GITHUB_ACTION_PATH\/((?:\.\.\/)+[^"'\s]*standards-index\.mjs)/,
    )?.[1];
    expect(
      relative,
      "the action must reach the generator via $GITHUB_ACTION_PATH",
    ).toBeDefined();

    const resolved = join(ACTION_DIR, relative!);
    expect(
      existsSync(resolved),
      `The action points at "${relative}" from its own directory, which resolves to\n` +
        `  ${resolved}\n` +
        `and nothing is there. The generator moved without the action following.`,
    ).toBe(true);
  });

  it("the action requires an explicit repo and never defaults one", () => {
    tagAc(AC(23));

    expect(ACTION).toMatch(/repo:[\s\S]{0,400}?required:\s*true/);
    // A default here would silently generate memex-ai's index inside
    // memex-clients — and report success.
    const repoInput = ACTION.split(/^\s{2}repo:/m)[1]?.split(/^\s{2}\w/m)[0] ?? "";
    expect(
      repoInput,
      "`repo` must have no default — the wrong index generated successfully is worse " +
        "than a failed run.",
    ).not.toMatch(/default:/);
  });
});
