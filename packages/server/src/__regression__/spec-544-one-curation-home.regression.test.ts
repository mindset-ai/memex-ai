// spec-544 dec-7 — the curated "Covers" prose has ONE home.
//
// WHAT WENT WRONG, measured. dec-3 gave each repo "an index and a manifest".
// Both existed for about ten minutes and already disagreed: std-1 read
// "Namespace / org / memex are three distinct concepts — plus user-facing
// vocabulary and handle conventions…" in memex-ai and "Namespace, org, and memex
// are distinct concepts" in memex-clients, because the latter was seeded from
// live titles with no curated source to draw on. All 51 of its summaries were
// placeholders, each repo's job rewrites only its own file, and nothing noticed.
// dec-3 reasoned about duplicated CODE and did not notice it was prescribing
// duplicated PROSE.
//
// dec-7's fix follows dec-3's own logic to its conclusion: a manifest exists to
// be compared against an index by the offline check, and memex-clients has no
// check, so the file there had no reader at all. It is gone. Curation lives in
// memex-ai; every other repo generates from it.
//
// These are the same two shapes of guard used elsewhere in this Spec — a pure
// test where the behaviour is pure, and a source guard where the property is
// about file placement and cannot be observed from inside this repo (the other
// repo's tree is not readable here). Said plainly rather than implied.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";
import { planIndex } from "../../../../scripts/ci/standards-index.mjs";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-544/acs/ac-${n}`;

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const SCRIPT = readFileSync(
  join(REPO_ROOT, "scripts", "ci", "standards-index.mjs"),
  "utf8",
);
const ACTION = readFileSync(
  join(REPO_ROOT, ".github", "actions", "standards-index", "action.yml"),
  "utf8",
);

describe("spec-544: a repo with no curation still gets the curated prose (ac-25)", () => {
  it("renders memex-ai's summary into memex-clients' table, not the live title", () => {
    tagAc(AC(25));

    // The live list only ever returns a title. The curated prose is richer, and
    // the whole point of one curation home is that the OTHER repo benefits from
    // it rather than falling back to the terse title.
    const live = [
      {
        handle: "std-44",
        title: "Flutter clients run through fvm, ship desktop-only",
        tags: [{ scope: null, value: "memex-clients" }],
      },
      {
        handle: "std-46",
        title: "A live pty in a Flutter tree is never disturbed",
        tags: [{ scope: null, value: "memex-clients" }],
      },
    ];
    // memex-ai's manifest — curated, and the only place this prose exists.
    const curated = [
      {
        handle: "std-44",
        summary:
          "Flutter clients run through fvm, ship desktop-only, and are not done " +
          "until analyze and test BOTH run clean.",
      },
    ];

    const { table, seeded } = planIndex({
      live,
      manifest: curated,
      repo: "memex-clients",
    });

    expect(
      table,
      "std-44 is curated in memex-ai, so memex-clients' index must carry that " +
        "prose — a repo without its own manifest is not a repo without good summaries.",
    ).toContain("and are not done until analyze and test BOTH run clean.");
    expect(
      seeded,
      "Only the Standard nobody has written prose for yet falls back to its title.",
    ).toEqual(["std-46"]);
    expect(table).toContain("A live pty in a Flutter tree is never disturbed");
  });
});

describe("spec-544: only the curation owner writes a manifest (ac-24)", () => {
  it("the manifest write is gated on curation being the output root", () => {
    tagAc(AC(24));

    // A memex-clients run reads memex-ai's manifest out of the action's own
    // ephemeral checkout. Writing to it there would be worse than pointless: the
    // seeded summary would be silently discarded when the runner is torn down,
    // so the next run would seed it again and report a placeholder forever.
    const sync = SCRIPT.slice(SCRIPT.search(/(?:async\s+)?function\s+sync\s*\(/));
    const body = sync.slice(0, sync.indexOf("\nasync function main"));

    expect(
      body,
      "sync() must compare the curation root against the output root before " +
        "writing the manifest.",
    ).toMatch(/curation\s*===\s*root|ownsCuration|isCurationOwner/);

    const writeAt = body.search(/writeFileSync\s*\(\s*manifestPath/);
    expect(writeAt, "sync() must still write the manifest somewhere").toBeGreaterThan(-1);

    const guardAt = body.search(/curation\s*===\s*root|ownsCuration|isCurationOwner/);
    expect(
      guardAt,
      "The ownership check must come BEFORE the manifest write, or the write " +
        "happens unconditionally and dec-7 is undone.",
    ).toBeLessThan(writeAt);
  });

  it("the two roots are separate arguments, and curation defaults to root", () => {
    tagAc(AC(24));

    expect(SCRIPT, "--curation must be a real argument").toMatch(/["']--curation["']/);
    expect(
      SCRIPT,
      "Defaulting curation to root keeps every memex-ai invocation unchanged — " +
        "one repo owning its own curation is the common case.",
    ).toMatch(/curation:\s*flag\(["']--curation["']\)\s*\?\?\s*root/);
  });

  it("the shared action points the two roots at different places", () => {
    tagAc(AC(24));

    // In a caller's run: --root is the CALLER's checkout, --curation is the
    // memex-ai checkout GitHub fetched for the action. Same value would silently
    // recreate a per-repo manifest.
    expect(ACTION).toMatch(/--root\s+"?\$(?:\{)?GITHUB_WORKSPACE/);
    expect(
      ACTION,
      "--curation must resolve into the ACTION's own checkout, which is where " +
        "memex-ai's curated manifest is.",
    ).toMatch(/--curation\s+"?\$(?:\{)?GITHUB_ACTION_PATH|--curation\s+"?\$\{?CURATION/);
  });
});
