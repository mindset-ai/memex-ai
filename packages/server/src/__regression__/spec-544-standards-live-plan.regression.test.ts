// spec-544 — the manifest and each repo's index are PLANNED from the live Standard
// list, not from an offline file that ages alongside its own check.
//
// THE DRIFT THIS ENDS (measured 2026-09-02, not hypothetical): the Memex held 51
// approved Standards; memex-ai's manifest listed 43. std-43…std-50 were absent and
// `make standards-check` was GREEN throughout — because it compares the manifest to
// CLAUDE.md and nothing else. Two offline files that age together always agree. The
// gap was found by hand.
//
// spec-512's sibling file pins the marker mechanics (every region rewritten, malformed
// markers refused). This file pins what spec-512 could not: that the SOURCE is live,
// that a new Standard is seeded rather than blocking, that a bad live response writes
// nothing, and that per-repo filtering FAILS OPEN.
//
// Everything here is pure — `planIndex` takes the live rows and the manifest as data,
// so these tests need no network. The network edge (`fetchLiveStandards`) is one thin
// function tested separately; keeping them apart is what lets `make check` stay offline
// (ac-10) while the plan itself is fully covered.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { planIndex } from "../../../../scripts/ci/standards-index.mjs";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-544/acs/ac-${n}`;

/** A live row as `?type=standard&include=tags` returns it. */
const live = (
  handle: string,
  title: string,
  repos: string[] = [],
) => ({
  handle,
  title,
  tags: repos.map((value) => ({ scope: null, value })),
});

const AI = "memex-ai";
const CLIENTS = "memex-clients";

describe("spec-544: a Standard missing from the manifest is SEEDED, never blocking", () => {
  it("seeds the live title as a placeholder summary and reports it (ac-8)", () => {
    tagAc(AC(8));

    const plan = planIndex({
      live: [
        live("std-1", "Namespace, org, and memex are distinct concepts"),
        live("std-44", "Flutter clients run through fvm and ship desktop-only"),
      ],
      manifest: [{ handle: "std-1", summary: "The curated, richer summary." }],
      repo: AI,
    });

    // The already-curated summary is NOT clobbered by the shorter live title.
    const one = plan.standards.find((s) => s.handle === "std-1");
    expect(
      one?.summary,
      "Seeding must never overwrite curated prose — the live API returns titles, " +
        "and the manifest's 'Covers' column is deliberately richer than a title.",
    ).toBe("The curated, richer summary.");

    // The new one is present, seeded from its title, and NAMED as a placeholder.
    const seeded = plan.standards.find((s) => s.handle === "std-44");
    expect(
      seeded?.summary,
      "std-44 exists in the Memex and had no manifest entry — it must be seeded " +
        "so the rule is VISIBLE immediately, not withheld until someone writes prose.",
    ).toBe("Flutter clients run through fvm and ship desktop-only");
    expect(plan.seeded).toEqual(["std-44"]);
  });

  it("reports nothing seeded when the manifest is already complete (ac-8)", () => {
    tagAc(AC(8));

    const plan = planIndex({
      live: [live("std-1", "T1")],
      manifest: [{ handle: "std-1", summary: "S1" }],
      repo: AI,
    });
    expect(plan.seeded).toEqual([]);
  });
});

describe("spec-544: a bad live response writes NOTHING", () => {
  it("refuses an empty live list rather than blanking the index (ac-9)", () => {
    tagAc(AC(9));

    // A visibility flip to private returns 404 (std-7), which is indistinguishable
    // from 'renamed' and from 'zero Standards'. Generating from that would blank the
    // table every agent orients from — the loudest possible failure is the only safe
    // behaviour, mirroring loadManifest()'s existing zero-standard refusal.
    expect(
      () => planIndex({ live: [], manifest: [{ handle: "std-1", summary: "S" }], repo: AI }),
      "An empty live list must THROW. Silently regenerating from it would erase the " +
        "index while reporting success.",
    ).toThrow(/live|zero|empty/i);
  });

  it("refuses a live list that is not an array (ac-9)", () => {
    tagAc(AC(9));

    for (const bad of [null, undefined, {}, "51 standards"]) {
      expect(
        () =>
          planIndex({
            live: bad as never,
            manifest: [{ handle: "std-1", summary: "S" }],
            repo: AI,
          }),
        `A live payload of ${JSON.stringify(bad)} must be refused, not coerced — a ` +
          `changed response shape must fail loud, not render an empty table.`,
      ).toThrow();
    }
  });
});

describe("spec-544: per-repo filtering FAILS OPEN", () => {
  // The spine of dec-2. Filtering re-creates this Spec's own harm one level down if
  // absence hides: an unattributed Standard would vanish from BOTH indexes and bind
  // nobody — strictly worse than today, where at least one repo lists it.
  const rows = [
    live("std-8", "Every mutation goes through mutate()", [AI]),
    live("std-44", "Flutter clients run through fvm", [CLIENTS]),
    live("std-51", "Module shape", [AI, CLIENTS]),
    live("std-20", "Drift is the enemy"), // deliberately unattributed
  ];
  const manifest = [
    { handle: "std-8", summary: "mutate() + bus" },
    { handle: "std-44", summary: "fvm, desktop-only" },
    { handle: "std-51", summary: "module shape" },
    { handle: "std-20", summary: "drift is the enemy" },
  ];

  it("an UNATTRIBUTED Standard appears in every repo's table (ac-14)", () => {
    tagAc(AC(14));

    for (const repo of [AI, CLIENTS]) {
      const { table } = planIndex({ live: rows, manifest, repo });
      expect(
        table,
        `std-20 carries no attribution, so it binds everything and MUST appear in ` +
          `${repo}'s index. An unattributed Standard that vanishes from both indexes ` +
          `is the exact harm this Spec exists to close.`,
      ).toMatch(/\|\s*std-20\s*\|/);
    }
  });

  it("with ZERO attribution anywhere, both tables are complete (ac-14)", () => {
    tagAc(AC(14));

    // Day one: 0 of 51 Standards carry a tag. Fail-open is what makes that a working
    // state rather than a flag day — the generator emits the COMPLETE index and
    // narrows incrementally as attribution lands.
    const untagged = rows.map((r) => ({ ...r, tags: [] }));
    for (const repo of [AI, CLIENTS]) {
      const { table } = planIndex({ live: untagged, manifest, repo });
      for (const h of ["std-8", "std-44", "std-51", "std-20"]) {
        expect(table, `${h} must be in ${repo}'s index when nothing is attributed`).toMatch(
          new RegExp(`\\|\\s*${h}\\s*\\|`),
        );
      }
    }
  });

  it("attribution narrows in both directions, and 'both' lands in both (ac-15)", () => {
    tagAc(AC(15));

    const aiTable = planIndex({ live: rows, manifest, repo: AI }).table;
    const clientsTable = planIndex({ live: rows, manifest, repo: CLIENTS }).table;

    expect(aiTable).toMatch(/\|\s*std-8\s*\|/);
    expect(
      clientsTable,
      "std-8 is memex-ai only (mutate() + the unified bus) — a Flutter repo's " +
        "orientation file listing it is the noise dec-2 chose to remove.",
    ).not.toMatch(/\|\s*std-8\s*\|/);

    expect(clientsTable).toMatch(/\|\s*std-44\s*\|/);
    expect(
      aiTable,
      "std-44 is memex-clients only (fvm / desktop-only).",
    ).not.toMatch(/\|\s*std-44\s*\|/);

    // The set case scoped tags could not express — which is why dec-1 chose flat.
    expect(aiTable, "std-51 binds both repos").toMatch(/\|\s*std-51\s*\|/);
    expect(clientsTable, "std-51 binds both repos").toMatch(/\|\s*std-51\s*\|/);
  });

  it("the manifest keeps EVERY Standard regardless of repo (ac-15)", () => {
    tagAc(AC(15));

    // The manifest is the offline authority on summaries for the whole Memex; only
    // the RENDERED table is filtered. If the manifest were filtered too, the curated
    // prose for the other repo's Standards would be lost on every regeneration.
    const { standards } = planIndex({ live: rows, manifest, repo: CLIENTS });
    expect(standards.map((s) => s.handle).sort()).toEqual(
      ["std-20", "std-44", "std-51", "std-8"].sort(),
    );
  });
});
