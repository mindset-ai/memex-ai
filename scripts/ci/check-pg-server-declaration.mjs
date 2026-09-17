// The local Postgres SERVER is read, never guessed (spec-524 ac-11, [per std-50]).
//
//   node scripts/ci/check-pg-server-declaration.mjs    # offline lane (`make check`)
//
// Why this exists: the defect spec-524 fixes was never a wrong value — 5432 is
// correct in CI. It was the SAME value independently guessed at three sites, so
// a machine whose pgvector Postgres sits elsewhere died inside migration 0023
// with an error naming no cause, and nothing anywhere said why. Removing the
// three literals without a guard just resets the clock: the next person who
// needs a quick default puts one back, and it is invisible again.
//
// TWIN-GUARD [per std-2]: `findPortLiterals` is the whole check, exported so the
// vitest regression suite asserts the same thing. `.husky/pre-push` runs lint +
// typecheck + unit tests and NOT `make check`, so a guard living only here would
// not see a push; one living only in vitest would not run in the offline CI lane.
// Two lanes, one function — never two implementations that can disagree.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PG_CAPABILITY_BYPASS } from "./e2e-preflight.mjs";

// The three places that guessed a port before spec-524. Scoped deliberately:
// `5432` is legitimate in documentation, fixtures and docker-compose, and a
// guard that fires on those gets switched off — which is this Spec's subject.
export const GUARDED = [
  "scripts/ci/workspace-alloc.mjs",
  "packages/server/src/db/test-db-url.ts",
  "Makefile",
];

// A Postgres port literal: either in a connection URL (`@host:5432/`) or handed
// to a libpq CLI (`-p 5432`, `--port=5432`). Matching the bare number would trip
// on comments explaining the very default we stopped restating.
const PORT_IN_URL = /@[A-Za-z0-9_.-]+:(\d{4,5})\//;
const PORT_AS_FLAG = /(?:^|\s)(?:-p|--port[= ])\s*(\d{4,5})\b/;

/** Every guarded site holding a Postgres port literal, as `file:line: text`.
 *  Pure: takes a root, reads files, returns findings. No process exit, no log. */
export function findPortLiterals(repoRoot) {
  const findings = [];
  for (const rel of GUARDED) {
    let body;
    try {
      body = readFileSync(join(repoRoot, rel), "utf8");
    } catch {
      // A guarded file that has moved is itself a finding — the guard would
      // otherwise silently protect nothing. Report it rather than skipping.
      findings.push(`${rel}: guarded file not found — did it move?`);
      continue;
    }
    for (const [i, line] of body.split("\n").entries()) {
      // A line that quotes a literal in order to explain why it is gone is the
      // point of the change, not a violation of it.
      if (/^\s*(#|\/\/|\*)/.test(line)) continue;
      if (PORT_IN_URL.test(line) || PORT_AS_FLAG.test(line)) {
        findings.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    }
  }
  return findings;
}



// ── spec-524 ac-20: the operating doc points at the declaration, never restates it
//
// CLAUDE.md is edited constantly, by several sessions, sometimes concurrently.
// "One reads from the other" survives exactly until the next edit unless something
// checks — and a doc that restates the DSN is a second statement of a fact the
// declaration owns, free to drift the moment either changes.
export const DOC_SITES = ["CLAUDE.md"];

/** Documentation restating a local Postgres DSN, as `file:line: text`. Pure. */
export function findDsnInDocs(repoRoot) {
  const findings = [];
  for (const rel of DOC_SITES) {
    let body;
    try {
      body = readFileSync(join(repoRoot, rel), "utf8");
    } catch {
      continue; // absent in a fixture or a consumer repo — nothing to police
    }
    for (const [i, line] of body.split("\n").entries()) {
      if (PORT_IN_URL.test(line)) findings.push(`${rel}:${i + 1}: ${line.trim()}`);
    }
  }
  return findings;
}

// ── spec-524 ac-17: CI never sets the capability-probe bypass ────────────────
//
// The hatch exists because a wrong probe on a required check blocks everybody.
// That reason is about a developer unblocking themselves — it has no CI reading.
// A runner that skips the probe produces a green whose meaning is smaller than
// it looks, which is the failure this Spec exists to remove. If the variable
// ever appears in a workflow, that is a defect and not a configuration choice.
export const WORKFLOW_DIR = ".github/workflows";

/** Every workflow file that sets the bypass, as `file:line: text`. Pure. */
export function findBypassInWorkflows(repoRoot) {
  const dir = join(repoRoot, WORKFLOW_DIR);
  let files;
  try {
    files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  } catch {
    return []; // no workflows here (a temp fixture, a consumer repo) — nothing to say
  }
  const findings = [];
  for (const name of files) {
    const body = readFileSync(join(dir, name), "utf8");
    for (const [i, line] of body.split("\n").entries()) {
      if (/^\s*#/.test(line)) continue;
      if (line.includes(PG_CAPABILITY_BYPASS)) {
        findings.push(`${WORKFLOW_DIR}/${name}:${i + 1}: ${line.trim()}`);
      }
    }
  }
  return findings;
}

function main(repoRoot) {
  const bypass = findBypassInWorkflows(repoRoot);
  if (bypass.length > 0) {
    process.stderr.write(
      `✗ a CI workflow sets ${PG_CAPABILITY_BYPASS}.\n\n` +
        bypass.map((f) => `    ${f}\n`).join("") +
        `\n  The hatch is for a developer unblocking themselves from a probe that\n` +
        `  got it wrong. A runner that skips the probe reports a green smaller than\n` +
        `  it looks. Remove it; if the probe is wrong, fix the probe.\n` +
        `  Check: scripts/ci/check-pg-server-declaration.mjs\n`,
    );
    return 1;
  }

  const docs = findDsnInDocs(repoRoot);
  if (docs.length > 0) {
    process.stderr.write(
      `✗ a local Postgres DSN is restated in documentation.\n\n` +
        docs.map((f) => `    ${f}\n`).join("") +
        `\n  The server is declared once, in the repo-root .env (template:\n` +
        `  .env.example). A doc that restates it is a second statement of the same\n` +
        `  fact, free to drift the moment either one changes — point at the\n` +
        `  declaration instead of repeating it.\n` +
        `  Check: scripts/ci/check-pg-server-declaration.mjs\n`,
    );
    return 1;
  }

  const findings = findPortLiterals(repoRoot);
  if (findings.length === 0) {
    process.stdout.write(
      "✓ Postgres server is read, not guessed; no CI workflow bypasses the probe\n"  +
      "  (spec-524 ac-11, ac-17, ac-20)\n",
    );
    return 0;
  }
  process.stderr.write(
    "✗ a Postgres port literal is back at a guarded site.\n\n" +
      findings.map((f) => `    ${f}\n`).join("") +
      "\n  The server is read from PGHOST/PGPORT, declared once in the repo-root\n" +
      "  .env (template: .env.example). Leave the port OUT of the url entirely\n" +
      "  when none is declared — libpq and postgres-js own that default, and\n" +
      "  restating it here is what let three sites drift apart [per std-50].\n" +
      "  Check: scripts/ci/check-pg-server-declaration.mjs\n",
  );
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv[2] ?? process.cwd()));
}
