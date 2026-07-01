// spec-440 ac-8: the restricted-role RLS project is CONFINED — the default suite
// (this test runs in it) still connects as the DB OWNER, which bypasses RLS
// (std-36: ENABLE, NO FORCE), so the 200+ owner-visibility suites are unaffected.
// Two independent guarantees:
//   1. the default project connects as an RLS-BYPASSING owner (not memex_app);
//   2. the default config EXCLUDES the *.rls-restricted.test.ts glob, so those
//      suites can only ever run under vitest.rls.config.ts (as memex_app).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "./connection.js";

const AC_8 = "mindset-prod/memex-building-itself/specs/spec-440/acs/ac-8";

describe("spec-440 ac-8: the restricted-role harness is confined to its own project", () => {
  it("the default suite connects as an RLS-bypassing owner (not memex_app)", async () => {
    tagAc(AC_8);

    const rows = (await db.execute(
      sql`SELECT current_user AS role, (rolsuper OR rolbypassrls) AS bypasses
          FROM pg_roles WHERE rolname = current_user`,
    )) as unknown as Array<{ role: string; bypasses: boolean }>;

    // Owner bypass is exactly why owner suites are unaffected: they see every
    // row regardless of app.memex_id. If this ever read `memex_app`, the default
    // suite would have flipped RLS-subject and could break unrelated suites.
    expect(rows[0]?.role).not.toBe("memex_app");
    expect(rows[0]?.bypasses).toBe(true);
  });

  it("the default vitest config excludes the *.rls-restricted.test.ts glob", () => {
    tagAc(AC_8);

    const configPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../vitest.config.ts",
    );
    const config = readFileSync(configPath, "utf8");
    // The restricted suites must be excluded here so they never run under the
    // owner connection (where the RLS assertion would be vacuous).
    expect(config).toContain("src/**/*.rls-restricted.test.ts");
  });
});
