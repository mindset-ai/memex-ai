// spec-243 ac-2: the 2-consecutive-failure decision table (dec-4) is a pure
// function shared by both runners (GitHub Actions + Cloud Run), so it's tested
// directly. Runner-agnostic: the only difference between runners is where
// prevStatus comes from (GitHub API vs GCS), which these tests inject.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  decideNotification,
  statusFromSummary,
} from "../../../../scripts/canary/notify.mjs";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-243";
const RED = { env: "prod", ok: false, results: { emission: { ok: false, detail: "POST /api/test-events → 401", body: '{"error":"unauthorized"}' }, page: { ok: true, detail: "GET / → 200", body: "" } } };
const GREEN = { env: "prod", ok: true, results: { page: { ok: true, detail: "GET / → 200", body: "" }, emission: { ok: true, detail: "→ 201", body: "" } } };
const base = { host: "memex.ai", verbose: false, runUrl: "https://run/log" };

describe("spec-243: canary notification decision table", () => {
  it("ac-2: RED + previous RED → claxon naming the failed probe + response", () => {
    tagAc(`${SPEC}/acs/ac-2`);
    const { decision, text } = decideNotification({ ...base, summary: RED, prevStatus: "red" });
    expect(decision).toBe("claxon");
    expect(text).toContain("CANARY RED");
    expect(text).toContain("emission");
    expect(text).toContain("401");
    expect(text).toContain("https://run/log");
  });

  it("ac-2: RED + previous GREEN → silent (the single-blip allowance)", () => {
    tagAc(`${SPEC}/acs/ac-2`);
    const { decision, text } = decideNotification({ ...base, summary: RED, prevStatus: "green" });
    expect(decision).toBe("silent");
    expect(text).toBeNull();
  });

  it("ac-2: first-ever RED (prev 'none') alerts immediately", () => {
    tagAc(`${SPEC}/acs/ac-2`);
    expect(decideNotification({ ...base, summary: RED, prevStatus: "none" }).decision).toBe("claxon");
  });

  it("ac-2: RED + prev 'unknown' (state unreadable) errs toward alerting", () => {
    tagAc(`${SPEC}/acs/ac-2`);
    expect(decideNotification({ ...base, summary: RED, prevStatus: "unknown" }).decision).toBe("claxon");
  });

  it("ac-2: GREEN + previous RED → all-clear", () => {
    tagAc(`${SPEC}/acs/ac-2`);
    const { decision, text } = decideNotification({ ...base, summary: GREEN, prevStatus: "red" });
    expect(decision).toBe("all-clear");
    expect(text).toContain("All clear");
  });

  it("ac-2: GREEN + previous GREEN → silent unless verbose", () => {
    tagAc(`${SPEC}/acs/ac-2`);
    expect(decideNotification({ ...base, summary: GREEN, prevStatus: "green" }).decision).toBe("silent");
    expect(decideNotification({ ...base, summary: GREEN, prevStatus: "green", verbose: true }).decision).toBe("verbose");
  });

  it("ac-2: status persisted matches run outcome", () => {
    tagAc(`${SPEC}/acs/ac-2`);
    expect(statusFromSummary(GREEN)).toBe("green");
    expect(statusFromSummary(RED)).toBe("red");
  });
});
