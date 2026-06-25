// Unit tests for the usage-events store (spec-244 t-1) — no DB.
//
// Covers the two pure/advisory behaviours: env-stamp derivation (dec-9) and the
// advisory swallow (ac-8 — a telemetry write never throws into its caller).

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import type { Db } from "../db/connection.js";
import { resolveEnv, recordUsageEvent } from "./usage-events.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-244/acs";

describe("resolveEnv — server-derived environment stamp (dec-9)", () => {
  it("maps APP_BASE_URL hosts to int / prod and localhost to local", () => {
    tagAc(`${AC}/ac-19`);
    // Test short-circuit takes precedence, so clear VITEST/NODE_ENV in the probes.
    const base = { VITEST: undefined, NODE_ENV: undefined } as unknown as NodeJS.ProcessEnv;
    expect(resolveEnv({ ...base, APP_BASE_URL: "https://int.memex.ai" })).toBe("int");
    expect(resolveEnv({ ...base, APP_BASE_URL: "https://memex.ai" })).toBe("prod");
    expect(resolveEnv({ ...base, APP_BASE_URL: "http://localhost:5173" })).toBe("local");
    // int must win over the prod substring match (int.memex.ai contains memex.ai).
    expect(resolveEnv({ ...base, APP_BASE_URL: "https://int.memex.ai/foo" })).toBe("int");
  });

  it("honours an explicit MEMEX_ENV override and short-circuits under test", () => {
    tagAc(`${AC}/ac-19`);
    const noTest = { VITEST: undefined, NODE_ENV: undefined } as unknown as NodeJS.ProcessEnv;
    expect(resolveEnv({ ...noTest, MEMEX_ENV: "prod", APP_BASE_URL: "http://localhost" })).toBe("prod");
    expect(resolveEnv({ VITEST: "1" } as unknown as NodeJS.ProcessEnv)).toBe("test");
  });
});

describe("recordUsageEvent — advisory (ac-8)", () => {
  it("swallows an insert failure and returns null, never throwing", async () => {
    tagAc(`${AC}/ac-8`);
    const throwingConn = {
      insert: () => ({
        values: () => ({
          returning: () => {
            throw new Error("db exploded");
          },
        }),
      }),
    } as unknown as Db;

    await expect(
      recordUsageEvent(
        { memexId: "11111111-1111-1111-1111-111111111111", name: "spec.created", source: "backend" },
        throwingConn,
      ),
    ).resolves.toBeNull();
  });

  it("skips (returns null) when memexId is blank — never produces an invalid row", async () => {
    tagAc(`${AC}/ac-8`);
    const conn = {
      insert: () => {
        throw new Error("should not be reached");
      },
    } as unknown as Db;
    await expect(
      recordUsageEvent({ memexId: "", name: "spec.created", source: "backend" }, conn),
    ).resolves.toBeNull();
  });
});
