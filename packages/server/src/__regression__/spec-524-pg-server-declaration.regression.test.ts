// spec-524 — the Postgres a test tier connects to stops being a silent default.
//
// The defect was never a wrong value: 5432 is correct in CI. It was a value one
// component depends on and another owns, defaulted in silence at three sites
// [per std-50]. dec-2 chose PGHOST/PGPORT as the single source because libpq
// honours them itself, which fixes the Makefile's six bare psql/dropdb/createdb
// calls without editing them. dec-7 then chose to emit a PORTLESS url when no
// port is declared, so the driver — which owns the default — resolves it, and
// this repo stops having an opinion about someone else's software.
//
// These assert the allocator half. The server-tier resolver is covered next to
// its source in db/test-db-url.test.ts.

import { describe, it, expect } from "vitest";
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  deriveE2eDbNames,
  resolveE2eConfig,
} from "../../../../scripts/ci/workspace-alloc.mjs";
import {
  findPortLiterals,
  findBypassInWorkflows,
  findDsnInDocs,
  GUARDED,
  WORKFLOW_DIR,
} from "../../../../scripts/ci/check-pg-server-declaration.mjs";
import {
  classifyPgCapability,
  describePgCapabilityFailure,
  PG_CAPABILITY_QUERY,
  PG_CAPABILITY_BYPASS,
  describeCapabilityBypass,
} from "../../../../scripts/ci/e2e-preflight.mjs";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-524/acs/ac-${n}`;

const WS = "/tmp/spec-524-workspace";

describe("spec-524: the allocator reads the Postgres server, it does not guess it", () => {
  it("PGPORT steers every resolved url (ac-7)", () => {
    tagAc(AC(7));
    const cfg = resolveE2eConfig({ PGPORT: "5433" }, WS);
    expect(new URL(cfg.databaseUrl).port).toBe("5433");
    expect(new URL(cfg.templateUrl).port).toBe("5433");
  });

  it("PGHOST steers every resolved url (ac-7)", () => {
    tagAc(AC(7));
    const cfg = resolveE2eConfig({ PGHOST: "db.internal" }, WS);
    expect(new URL(cfg.databaseUrl).hostname).toBe("db.internal");
    expect(new URL(cfg.templateUrl).hostname).toBe("db.internal");
  });

  it("naming the server does not rename the database (ac-8)", () => {
    tagAc(AC(8));
    // dec-2 moves WHERE the server is named, never HOW the database is named.
    // The workspace derivation spec-512 owns must survive untouched.
    const names = deriveE2eDbNames(WS);
    const cfg = resolveE2eConfig({ PGPORT: "5433", PGHOST: "db.internal" }, WS);
    expect(cfg.databaseName).toBe(names.database);
    expect(cfg.templateName).toBe(names.template);
    expect(new URL(cfg.databaseUrl).pathname).toBe(`/${names.database}`);
    expect(new URL(cfg.templateUrl).pathname).toBe(`/${names.template}`);
  });

  it("with neither variable set the url carries NO port, so the driver resolves it (ac-9, ac-22)", () => {
    tagAc(AC(9));
    tagAc(AC(22));
    // This is dec-7. An empty `port` is not an omission — it is the point:
    // postgres-js (src/index.js:439 `port = o.port || url.port || env.PGPORT
    // || 5432`) and libpq both fall through to their own default, which is the
    // 5432 a CI runner already uses. The repo holds no opinion to drift.
    const cfg = resolveE2eConfig({}, WS);
    expect(new URL(cfg.databaseUrl).port).toBe("");
    expect(new URL(cfg.templateUrl).port).toBe("");
    expect(cfg.databaseUrl).not.toContain("5432");
    expect(cfg.templateUrl).not.toContain("5432");
    // Host and credentials are NOT what this decision moved.
    expect(new URL(cfg.databaseUrl).hostname).toBe("localhost");
    expect(new URL(cfg.databaseUrl).username).toBe("postgres");
  });

  it("E2E_DATABASE_URL keeps its verbatim semantics and PGPORT cannot rewrite it (ac-10)", () => {
    tagAc(AC(10));
    // spec-512 dec-3 preserved this escape hatch deliberately: someone naming a
    // database by hand means it. dec-2 adds a way to name the SERVER and takes
    // nothing away, so an explicit url must win outright — including its port.
    const explicit = "postgresql://postgres:postgres@localhost:6543/my_exact_db";
    const cfg = resolveE2eConfig(
      { E2E_DATABASE_URL: explicit, PGPORT: "5433" },
      WS,
    );
    expect(cfg.databaseUrl).toBe(explicit);
    expect(cfg.databaseName).toBe("my_exact_db");
    expect(cfg.usingOverride).toBe(true);
  });
});

describe("spec-524: the declaration is bound to this repository, not to a shell", () => {
  const repoRoot = join(import.meta.dirname, "../../../..");
  const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

  it("no committed file tells a developer to put a PG* variable in a shell profile (ac-19)", () => {
    tagAc(AC(19));
    // dec-2 accepted that PGPORT is process-global. The bound that keeps that
    // cost inside this repo is WHERE the value is declared: a repo file steers
    // this repo's commands, a login shell steers every psql the developer runs
    // all day — including one aimed at a database that matters.
    //
    // The Makefile's own `export PGPORT` is the sanctioned mechanism, not an
    // instruction, so this looks for a shell PROFILE named near a PG* variable.
    const PROFILES = /\.zshrc|\.bashrc|\.bash_profile|\.profile\b/;
    const tracked = execFileSync("git", ["ls-files", "-z"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    })
      .split("\0")
      .filter((f) => /\.(md|example|mjs|ts|sh)$|^Makefile$/.test(f));

    const offenders: string[] = [];
    for (const file of tracked) {
      let body: string;
      try {
        body = read(file);
      } catch {
        continue; // deleted in the working tree; not our business
      }
      for (const [i, line] of body.split("\n").entries()) {
        if (!PROFILES.test(line)) continue;
        if (!/\bPG(HOST|PORT|PASSWORD|USER|DATABASE)\b/.test(line)) continue;
        // A line that names a profile in order to FORBID it is the point.
        if (/\b(not|never|don'?t|avoid|rather than|instead of)\b/i.test(line)) {
          continue;
        }
        offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the declaration lives in a repo file and .env.example documents it (ac-19)", () => {
    tagAc(AC(19));
    // The mechanism must actually exist, or the test above passes vacuously by
    // there being nothing to instruct.
    const makefile = read("Makefile");
    expect(makefile).toMatch(/PGPORT\s*\?=.*\.env/);
    expect(makefile).toMatch(/^export PGPORT$/m);

    const example = read(".env.example");
    expect(example).toMatch(/PGPORT/);
    // ...and it must say the quiet part out loud, since this is the one bound
    // a developer can defeat by hand without anything noticing.
    expect(example).toMatch(/zshrc|bashrc|login shell/i);

    // The file the developer edits is gitignored — repo-scoped, not committed,
    // and not a place a real value can leak from.
    expect(read(".gitignore")).toMatch(/^\.env$/m);
  });
});

describe("spec-524: the silent default cannot come back by accident", () => {
  const repoRoot = join(import.meta.dirname, "../../../..");

  // TWIN-GUARD [per std-2]. The same `findPortLiterals` runs in two lanes
  // because neither alone covers both moments: `.husky/pre-push` runs lint +
  // typecheck + unit tests and NOT `make check`, while the offline CI battery
  // runs `make check` and no vitest. Importing the function rather than
  // re-implementing the scan is the part that matters — two implementations
  // would eventually disagree, and the quiet one would be the one trusted.
  it("no Postgres port literal survives at the three guarded sites (ac-11)", () => {
    tagAc(AC(11));
    expect(findPortLiterals(repoRoot)).toEqual([]);
  });

  it("the guard actually fires — it is not passing because it looks nowhere (ac-11)", () => {
    tagAc(AC(11));
    // A scan that finds nothing looks identical to a scan that searches nothing.
    // Feed the real function a tree where the literal IS present and require it
    // to say so, naming the file.
    const fixture = mkdtempSync(join(tmpdir(), "spec-524-guard-"));
    try {
      mkdirSync(join(fixture, "scripts/ci"), { recursive: true });
      mkdirSync(join(fixture, "packages/server/src/db"), { recursive: true });
      writeFileSync(
        join(fixture, "scripts/ci/workspace-alloc.mjs"),
        'const base = "postgresql://postgres:postgres@localhost:5432/memex";\n',
      );
      writeFileSync(
        join(fixture, "packages/server/src/db/test-db-url.ts"),
        "// postgresql://postgres:postgres@localhost:5432/memex — a comment is NOT a violation\n",
      );
      writeFileSync(join(fixture, "Makefile"), "\tpsql -p 5432 -U postgres\n");

      const found = findPortLiterals(fixture);
      expect(found.join("\n")).toMatch(/workspace-alloc\.mjs:1/);
      expect(found.join("\n")).toMatch(/Makefile:1/);
      // The comment line must NOT be reported: explaining the literal we removed
      // is the point of the change, and a guard that forbids saying so would be
      // uninhabitable.
      expect(found.join("\n")).not.toMatch(/test-db-url\.ts:1/);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("a guarded file that moves is reported, not silently skipped (ac-11)", () => {
    tagAc(AC(11));
    // The worst failure mode for a path-based guard is protecting nothing while
    // reporting success.
    const empty = mkdtempSync(join(tmpdir(), "spec-524-empty-"));
    try {
      expect(findPortLiterals(empty).length).toBe(GUARDED.length);
      expect(findPortLiterals(empty).join("\n")).toMatch(/did it move\?/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("spec-524: the preflight refuses a Postgres that cannot replay the migrations", () => {
  // These exercise the PURE cores on purpose. The end-to-end behaviour depends on
  // what Postgres this machine happens to run — CI's 5432 IS pgvector-capable,
  // this workstation's is not — so a test that shelled out would assert the
  // machine rather than the claim, and would be red in exactly one of the two
  // places. The live behaviour is recorded as evidence on t-4 instead.

  // Retagged 12 -> 24 (2026-09-18). dec-3's criterion was superseded when the
  // version clause came out: pgvector runs on Postgres 14, so a version floor was
  // the wrong predicate. The supersession minted ac-24 and left these tests
  // pointing at the retired handle — green, passing, and proving a criterion that
  // no longer governs, while the one that does had no evidence at all.
  it("an incapable target is refused; a capable one is admitted (ac-24, ac-14)", () => {
    tagAc(AC(24));
    tagAc(AC(14));
    expect(
      classifyPgCapability({ vectorAvailable: true, version: "16.14", port: "5433" }),
    ).toEqual({ ok: true, examined: true });

    const refused = classifyPgCapability({
      vectorAvailable: false,
      version: "14.20",
      port: "5432",
    });
    expect(refused.ok).toBe(false);
    expect(refused.examined).toBe(true);
    if (refused.ok !== false) throw new Error("expected a refusal");
    expect(refused.port).toBe("5432");
    expect(refused.version).toBe("14.20");
  });

  it("a probe that learned nothing is SKIPPED, never counted as a pass (ac-24)", () => {
    tagAc(AC(24));
    // psql absent, Postgres down, bad credentials — the check examined nothing.
    // Counting that as passed is how a preflight reports a clean bill of health
    // it never earned, which is the shape of defect this whole Spec is about.
    const v = classifyPgCapability({ unreachable: true, why: "psql: not found" });
    expect(v.examined).toBe(false);
    expect(v.ok).toBe(true); // does not FAIL the run either — it abstains
    expect(classifyPgCapability(null).examined).toBe(false);
  });

  it("the refusal names the port, the version, the consequence and the fix (ac-13)", () => {
    tagAc(AC(13));
    const message = describePgCapabilityFailure({
      version: "14.20",
      port: "5432",
    });
    // What it reached...
    expect(message).toMatch(/landed on port 5432/);
    expect(message).toMatch(/PostgreSQL 14\.20/);
    expect(message).toMatch(/vector` is NOT in pg_available_extensions/);
    // ...what will happen...
    expect(message).toMatch(/0023_add_codebase_intelligence\.sql/);
    expect(message).toMatch(/vector\.control/);
    // ...and what to change. A refusal that does not say this is just a
    // different unusable gate.
    expect(message).toMatch(/PGPORT=/);
    expect(message).toMatch(/\.env/);
  });

  it("the port comes from the server, and a unix socket says so in words (ac-23)", () => {
    tagAc(AC(23));
    // The query asks the SERVER where we landed rather than restating PGPORT:
    // where a variable and reality disagree, reality is what prints.
    expect(PG_CAPABILITY_QUERY).toMatch(/inet_server_port\(\)/);
    expect(PG_CAPABILITY_QUERY).toMatch(/pg_available_extensions/);

    // inet_server_port() is NULL over a unix socket. A blank field would replace
    // a silent error with an empty one, which is no improvement.
    const overSocket = classifyPgCapability({
      vectorAvailable: false,
      version: "16.14",
      port: null,
    });
    // Narrowed deliberately: the refusing branch is the only one carrying a
    // port, and the type says so. Reaching for `.port` without checking would
    // be the same shape of assumption this Spec removes from the code.
    expect(overSocket.ok).toBe(false);
    if (overSocket.ok !== false) throw new Error("expected a refusal");
    expect(overSocket.port).toBe("unix socket");
    expect(describePgCapabilityFailure(overSocket)).toMatch(
      /landed on port unix socket/,
    );
  });
});

describe("spec-524: the escape hatch is narrow, loud, and absent from CI", () => {
  const repoRoot = join(import.meta.dirname, "../../../..");
  const runPreflight = (env: Record<string, string>) => {
    try {
      return {
        code: 0,
        out: execFileSync("node", ["scripts/ci/e2e-preflight.mjs"], {
          cwd: repoRoot,
          encoding: "utf8",
          env: { ...process.env, ...env },
          timeout: 30_000,
        }),
      };
    } catch (err: any) {
      return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
    }
  };

  it("the hatch disarms the probe ONLY — the other checks still run (ac-15)", () => {
    tagAc(AC(15));
    // Machine-independent: with the hatch set the capability probe is skipped
    // whatever Postgres is here, so this asserts the same thing on CI and on a
    // workstation. What it must show is that the REST of the preflight ran.
    const { out } = runPreflight({ [PG_CAPABILITY_BYPASS]: "1" });
    // The probe is silent...
    expect(out).not.toMatch(/cannot replay the migrations/);
    // ...and the rest of the preflight still reached a verdict. Asserted this
    // way rather than on a pass, because whether the OTHER checks are happy
    // depends on what is listening on this machine right now — that is the
    // ambient state, not the claim.
    expect(out).toMatch(/\d+ checks/);
  });

  it("there is no variable that disarms the preflight as a whole (ac-15)", () => {
    tagAc(AC(15));
    // A blanket switch would hand anyone working around one mistaken probe the
    // power to turn off four unrelated guards. The bypass must be consulted in
    // exactly one place, and that place is the capability check.
    const src = readFileSync(join(repoRoot, "scripts/ci/e2e-preflight.mjs"), "utf8");
    const uses = src.match(/process\.env\[PG_CAPABILITY_BYPASS\]/g) ?? [];
    expect(uses).toHaveLength(1);
    expect(src).toMatch(
      /async function checkPgCapability[\s\S]{0,200}process\.env\[PG_CAPABILITY_BYPASS\]/,
    );
  });

  it("a bypassed run cannot read as a clean one (ac-16)", () => {
    tagAc(AC(16));
    // The words are the claim, so the words are the unit.
    const notice = describeCapabilityBypass([PG_CAPABILITY_BYPASS]);
    expect(notice).toContain(PG_CAPABILITY_BYPASS);
    expect(notice).toMatch(/BYPASSED/);
    expect(notice).toMatch(/NOT a clean preflight/);

    // And it reaches a real run — on BOTH paths. The first cut printed this only
    // on the happy path, so a run that was bypassed AND tripped another check
    // announced nothing: the loudness bound held exactly where it was least
    // needed. That defect is why this asserts the live output too.
    const bypassed = runPreflight({ [PG_CAPABILITY_BYPASS]: "1" });
    expect(bypassed.out).toContain(PG_CAPABILITY_BYPASS);
    expect(bypassed.out).toMatch(/NOT a clean preflight/);
    // Someone skimming the summary sees ⚠, never a bare ✓.
    expect(bypassed.out).not.toMatch(/✓ e2e preflight passed/);
  });

  it("no CI workflow sets the bypass, and the guard would say so if one did (ac-17)", () => {
    tagAc(AC(17));
    expect(findBypassInWorkflows(repoRoot)).toEqual([]);

    // ...and the guard is not passing merely by looking nowhere.
    const fixture = mkdtempSync(join(tmpdir(), "spec-524-wf-"));
    try {
      mkdirSync(join(fixture, WORKFLOW_DIR), { recursive: true });
      writeFileSync(
        join(fixture, WORKFLOW_DIR, "ci.yml"),
        `jobs:\n  e2e:\n    env:\n      ${PG_CAPABILITY_BYPASS}: "1"\n`,
      );
      writeFileSync(
        join(fixture, WORKFLOW_DIR, "commented.yml"),
        `# ${PG_CAPABILITY_BYPASS}: "1"  <- a comment is not a setting\n`,
      );
      const found = findBypassInWorkflows(fixture);
      expect(found.join("\n")).toMatch(/ci\.yml:4/);
      expect(found.join("\n")).not.toMatch(/commented\.yml/);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe("spec-524: the operating doc points at the declaration, never restates it", () => {
  const repoRoot = join(import.meta.dirname, "../../../..");

  it("CLAUDE.md names the declaration and carries no DSN literal (ac-20)", () => {
    tagAc(AC(20));
    expect(findDsnInDocs(repoRoot)).toEqual([]);

    const claude = readFileSync(join(repoRoot, "CLAUDE.md"), "utf8");
    expect(claude).toMatch(/PGHOST/);
    expect(claude).toMatch(/PGPORT/);
    expect(claude).toMatch(/\.env\.example/);
    // The shell-profile bound is stated where a developer will actually read it,
    // not only in .env.example.
    expect(claude).toMatch(/zshrc|shell\s+profile/i);
  });

  it("the doc guard fires when a DSN comes back (ac-20)", () => {
    tagAc(AC(20));
    // CLAUDE.md is edited constantly, by several sessions, sometimes at once.
    // "One reads from the other" survives until the next edit unless something
    // checks — so the check must be shown to check.
    const fixture = mkdtempSync(join(tmpdir(), "spec-524-doc-"));
    try {
      writeFileSync(
        join(fixture, "CLAUDE.md"),
        "Local Postgres: `postgresql://postgres:postgres@localhost:5432/memex`\n",
      );
      expect(findDsnInDocs(fixture).join("\n")).toMatch(/CLAUDE\.md:1/);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
