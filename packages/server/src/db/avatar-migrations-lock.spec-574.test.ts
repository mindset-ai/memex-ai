import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// spec-574: both avatar migrations ALTER `users`, which every authenticated request reads.
// Each must set a lock timeout BEFORE its first ALTER, so a long-running reader at deploy
// time fails the migration fast instead of queueing every request behind the ALTER.
const DRIZZLE = join(__dirname, "..", "..", "drizzle");
const FILES = ["0154_spec574_user_avatar_label.sql", "0155_spec574_user_avatar_color.sql"];

function statements(file: string): string[] {
  return readFileSync(join(DRIZZLE, file), "utf8")
    .split("--> statement-breakpoint")
    .map((s) =>
      s
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter(Boolean);
}

describe("spec-574 avatar migrations take the users lock safely", () => {
  it.each(FILES)("%s sets lock_timeout before any ALTER", (file) => {
    const stmts = statements(file);
    const firstAlter = stmts.findIndex((s) => /ALTER\s+TABLE/i.test(s));
    const timeout = stmts.findIndex((s) => /^SET\s+LOCAL\s+lock_timeout\s*=/i.test(s));
    expect(firstAlter).toBeGreaterThan(-1); // vacuity: the file really alters users
    expect(timeout).toBeGreaterThan(-1);
    expect(timeout).toBeLessThan(firstAlter);
  });
});

// SET LOCAL only lasts to the end of a transaction. The lock timeout above protects the
// ALTERs only because each migration file is applied inside ONE transaction; if an
// applier stopped doing that, the timeout would silently become a no-op.
describe("spec-574: hand migrations are applied one file per transaction", () => {
  const scripts = join(__dirname, "..", "..", "scripts");

  it("apply-hand-migrations.mjs wraps each file in sql.begin", () => {
    const src = readFileSync(join(scripts, "apply-hand-migrations.mjs"), "utf8");
    expect(src).toMatch(/sql\.begin\(/);
  });

  it("apply-hand-migrations.sh runs psql with --single-transaction", () => {
    const src = readFileSync(join(scripts, "apply-hand-migrations.sh"), "utf8");
    expect(src).toMatch(/--single-transaction/);
  });
});
