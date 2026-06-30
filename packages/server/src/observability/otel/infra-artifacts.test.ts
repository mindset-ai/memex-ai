import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";

const AC3 = "mindset-prod/memex-building-itself/specs/spec-412/acs/ac-3";
const AC4 = "mindset-prod/memex-building-itself/specs/spec-412/acs/ac-4";

const OTEL_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = join(OTEL_DIR, "..", "..", "..");
const REPO_ROOT = join(SERVER_ROOT, "..", "..");

describe("pg_stat_statements enablement is shipped as an infra artifact (ac-4)", () => {
  const sqlPath = join(SERVER_ROOT, "scripts", "enable-pg-stat-statements.sql");

  it("ships an idempotent enabling script for the tuning extension", () => {
    tagAc(AC4);
    expect(existsSync(sqlPath)).toBe(true);
    const sql = readFileSync(sqlPath, "utf8");
    expect(sql).toMatch(/CREATE EXTENSION IF NOT EXISTS pg_stat_statements/i);
  });

  it("keeps it OUT of the auto-migration path (cold CI can't preload it)", () => {
    tagAc(AC4);
    // Living under scripts/, not drizzle/, is what keeps the migrate step green.
    expect(existsSync(join(SERVER_ROOT, "drizzle", "enable-pg-stat-statements.sql")))
      .toBe(false);
    const sql = readFileSync(sqlPath, "utf8");
    // Documents the instance-level prerequisite so an operator isn't stranded.
    expect(sql.toLowerCase()).toContain("shared_preload_libraries");
  });
});

describe("self-host redirect is wired into deploy config (ac-3)", () => {
  it("the OTLP endpoint flows through deploy config to the runtime env", () => {
    tagAc(AC3);
    const deployConfig = readFileSync(
      join(REPO_ROOT, "scripts", "deploy-config.sh"),
      "utf8",
    );
    expect(deployConfig).toContain("OTEL_EXPORTER_OTLP_ENDPOINT");

    const serverDeploy = readFileSync(
      join(SERVER_ROOT, "deploy.sh"),
      "utf8",
    );
    // Passed via the same set-vs-unset merge idiom, so an unset value never
    // blanks a live endpoint.
    expect(serverDeploy).toContain(
      "${OTEL_EXPORTER_OTLP_ENDPOINT+|OTEL_EXPORTER_OTLP_ENDPOINT=",
    );
  });
});
