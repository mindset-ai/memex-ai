// spec-566 t-1 — source scans for the two properties no passing test can express.
//
// Both claims here are about the ABSENCE of code. A behavioural test can only
// show that something DOES happen; "there is no restore path" and "the sweep
// never reaches this table" are statements about what is NOT written, and the
// only thing that can hold them is a scan that reads the source.
//
//   ac-17  WRITE-ONCE — no update and no delete outside the journal's own module,
//          and no restore path anywhere. A restore path would make this the
//          `hidden` column spec-358 dec-1 removed, under a new name, and would
//          fail that decision on its real grounds.
//
//   ac-15  NOT SWEPT — the journal's table name appears in no retention target.
//          NOTE this AC was reworded on 2026-09-15, before implementation: the
//          original said "age a row past PULSE_RETENTION_DAYS, run the sweep,
//          assert it survives". `sweepActivityLog` deletes from `activity_log`
//          ONLY, so a separate table survives it with ZERO code written — that
//          test is green on an unimplemented feature. The real risk is a future
//          author extending the sweep to cover the journal, and a scan is what
//          catches that.
//
// Failure messages carry the REASONING, not just the violation: the point is to
// hand the next author dec-3, so they change the decision deliberately rather
// than routing around a red test.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const AC = "mindset-prod/memex-building-itself/specs/spec-566/acs";
const SRC_DIR = join(__dirname, "..");

const TABLE_SQL = "spec_lifecycle_events";
const TABLE_TS = "specLifecycleEvents";

/** The module that owns the table. Its single insert is the whole write surface. */
const OWNER = "services/lifecycle-journal.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Production source only — a test's own fixture cleanup is not a restore path. */
function productionFiles(): { rel: string; text: string }[] {
  return walk(SRC_DIR)
    .filter((f) => !/\.(test|spec)\.ts$/.test(f) && !f.includes(`${sep}__regression__${sep}`))
    .map((f) => ({
      rel: relative(SRC_DIR, f).split(sep).join("/"),
      text: readFileSync(f, "utf8"),
    }));
}

describe("spec-566 lifecycle journal — guards", () => {
  it("is write-once: nothing updates or deletes the journal, and no restore path exists", () => {
    tagAc(`${AC}/ac-17`);

    const files = productionFiles();
    // Vacuity guard: if the walk returns nothing, every assertion below passes
    // for the wrong reason.
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.rel === OWNER)).toBe(true);

    const offenders: string[] = [];
    for (const { rel, text } of files) {
      // Pass A — amendment. Needs the table symbol in scope to be expressible at
      // all, so it is correctly limited to files that name it.
      if (text.includes(TABLE_TS) || text.includes(TABLE_SQL)) {
        const mutating =
          /\.\s*(update|delete)\s*\(\s*specLifecycleEvents/.test(text) ||
          new RegExp(`(UPDATE|DELETE\\s+FROM)\\s+"?${TABLE_SQL}"?`, "i").test(text);
        if (mutating) offenders.push(`${rel} — updates or deletes the journal`);
      }

      // Pass B — restoration. Scanned across EVERY production file, not just
      // those naming the table: the dangerous shape is a helper somewhere else
      // that puts back what a retirement removed, and such a file need never
      // mention the journal. Gating this on the table name left exactly that hole
      // — proven by a mutation probe during t-1, where a `restoreLifecycleEvent`
      // planted in services/acs.ts kept the scan green.
      if (/restore[A-Za-z]*LifecycleEvent|unretire|undiscontinue|restoreTestEvents/i.test(text)) {
        offenders.push(`${rel} — looks like a restore path`);
      }
    }

    expect(
      offenders,
      `The lifecycle journal is WRITE-ONCE [spec-566 dec-3]. A row records an act that
already happened; it is never amended and never read back to put something back.

spec-358 dec-1 removed the \`hidden\` column precisely because it was a MUTABLE flag
whose purpose was RESTORING rows, and accepted losing that reversibility. dec-3 is
only defensible because this table is the opposite object — a receipt, not a switch.
An update or restore path here re-opens that decision without re-deciding it.

If you genuinely need to reverse an act, record a NEW row that says so.

Offending files:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("sits outside every retention path — the sweep must never reach it", () => {
    tagAc(`${AC}/ac-15`);

    // Retention files are identified BY PATH, not by prose. Matching on text
    // (`RETENTION_DAYS`, `DELETE FROM`) flags any file that merely *explains* the
    // retention question — schema.ts's own comment about why activity_log is the
    // wrong home tripped exactly that during this task.
    //
    // A new sweep hidden in a file named nothing like a sweep is not missed: it
    // would have to issue a DELETE against the table, which the write-once rule
    // above already flags. The two rules cover each other's blind spot.
    const sweepish = productionFiles().filter(({ rel }) =>
      /sweep|retention|purge|prune/i.test(rel),
    );
    // Vacuity guard: the known sweep must be in the set, or this scan is looking
    // at nothing and would stay green however the journal were swept.
    expect(
      sweepish.map((f) => f.rel),
      "the activity-log sweep must be in scope for this scan",
    ).toContain("services/activity-log-sweep.ts");

    const offenders = sweepish
      .filter(({ text }) => text.includes(TABLE_SQL) || text.includes(TABLE_TS))
      .map((f) => f.rel);

    expect(
      offenders,
      `The lifecycle journal is OUTSIDE every retention path [spec-566 dec-3].

\`activity_log\` cannot host this record precisely because it is swept at
PULSE_RETENTION_DAYS (default 30) — a tombstone that expires in 30 days is not a
tombstone. Adding the journal to a sweep re-creates the exact defect the separate
table was built to avoid.

Volume is not the reason to sweep it: these are rare deliberate acts, tens of rows
per year per Memex [std-39]. If growth ever becomes real, that is a decision to
re-open on the Spec, not a line to add to a sweep.

Offending files:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});
