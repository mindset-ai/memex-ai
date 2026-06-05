import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { isEmissionEnabled, isHidden, buildPayload, tagAc } from "./index.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-115/acs";
const SPEC_89 = "mindset-prod/memex-building-itself/specs/spec-89/acs";

beforeEach(() => {
  // Ensure no platform signals leak into payload-shape tests.
  vi.stubEnv("CI", "");
  vi.stubEnv("GITHUB_ACTIONS", "");
  vi.stubEnv("GITLAB_CI", "");
  vi.stubEnv("BUILDKITE", "");
  vi.stubEnv("CIRCLECI", "");
  // Clear the actor fallback chain so the dev's $USER doesn't leak into
  // payload-shape assertions.
  vi.stubEnv("GITHUB_ACTOR", "");
  vi.stubEnv("GITLAB_USER_LOGIN", "");
  vi.stubEnv("BUILDKITE_BUILD_AUTHOR", "");
  vi.stubEnv("CIRCLE_USERNAME", "");
  vi.stubEnv("USER", "");
  vi.stubEnv("USERNAME", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isEmissionEnabled — MEMEX_EMIT parsing", () => {
  it("returns true when MEMEX_EMIT is unset (ac-6)", () => {
    tagAc(`${AC}/ac-6`);
    vi.stubEnv("MEMEX_EMIT", "");
    expect(isEmissionEnabled()).toBe(true);
  });

  it("returns false when MEMEX_EMIT=false (ac-7) [spec-115 scope ac-1]", () => {
    tagAc(`${AC}/ac-7`);
    // spec-115 scope ac-1: adopters can turn emissions off per environment
    // by setting a single env var. No code changes to test files.
    tagAc(`${AC}/ac-1`);
    vi.stubEnv("MEMEX_EMIT", "false");
    expect(isEmissionEnabled()).toBe(false);
  });

  it("returns false when MEMEX_EMIT=FALSE (case-insensitive) (ac-7)", () => {
    tagAc(`${AC}/ac-7`);
    vi.stubEnv("MEMEX_EMIT", "FALSE");
    expect(isEmissionEnabled()).toBe(false);
  });

  it("returns false when MEMEX_EMIT=0 (ac-7)", () => {
    tagAc(`${AC}/ac-7`);
    vi.stubEnv("MEMEX_EMIT", "0");
    expect(isEmissionEnabled()).toBe(false);
  });

  it("returns false when MEMEX_EMIT=no (ac-7)", () => {
    tagAc(`${AC}/ac-7`);
    vi.stubEnv("MEMEX_EMIT", "no");
    expect(isEmissionEnabled()).toBe(false);
  });

  it("returns false when MEMEX_EMIT=off (ac-7)", () => {
    tagAc(`${AC}/ac-7`);
    vi.stubEnv("MEMEX_EMIT", "off");
    expect(isEmissionEnabled()).toBe(false);
  });

  it("returns true when MEMEX_EMIT=true (ac-8)", () => {
    tagAc(`${AC}/ac-8`);
    vi.stubEnv("MEMEX_EMIT", "true");
    expect(isEmissionEnabled()).toBe(true);
  });

  it("returns true for malformed values (ac-9)", () => {
    tagAc(`${AC}/ac-9`);
    vi.stubEnv("MEMEX_EMIT", "banana");
    expect(isEmissionEnabled()).toBe(true);
  });

  it("returns true when MEMEX_EMIT=yes (any non-off value) (ac-9)", () => {
    tagAc(`${AC}/ac-9`);
    vi.stubEnv("MEMEX_EMIT", "yes");
    expect(isEmissionEnabled()).toBe(true);
  });
});

describe("isHidden — MEMEX_HIDDEN and per-call", () => {
  it("returns false when both env and per-call are unset", () => {
    expect(isHidden()).toBe(false);
  });

  it("returns true when per-call hidden=true", () => {
    expect(isHidden(true)).toBe(true);
  });

  it("returns true when MEMEX_HIDDEN=true", () => {
    vi.stubEnv("MEMEX_HIDDEN", "true");
    expect(isHidden()).toBe(true);
  });

  it("returns true when MEMEX_HIDDEN=1", () => {
    vi.stubEnv("MEMEX_HIDDEN", "1");
    expect(isHidden()).toBe(true);
  });

  it("per-call true wins even when env disagrees", () => {
    vi.stubEnv("MEMEX_HIDDEN", "false");
    expect(isHidden(true)).toBe(true);
  });
});

describe("buildPayload — wire format", () => {
  it("produces the minimal payload when no options and no env (ac-12) [spec-89 ac-4, spec-115 scope ac-5]", () => {
    tagAc(`${AC}/ac-12`);
    // spec-89 ac-4: the wire format the helper POSTs to /api/test-events
    // is unchanged by the workspace-package restructure. The minimal
    // payload here is the same shape pre-v0.1.0 consumers were posting.
    tagAc(`${SPEC_89}/ac-4`);
    // spec-115 scope ac-5: existing helpers and consumers continue to
    // work unchanged. A caller using only tagAc('<ref>') without options
    // sees identical behaviour.
    tagAc(`${AC}/ac-5`);
    const payload = buildPayload({
      ac_uid: "mindset-prod/foo/specs/spec-1/acs/ac-1",
      status: "pass",
      test_identifier: "test.ts::it works",
      duration_ms: 42,
    });
    expect(payload).toEqual({
      ac_uid: "mindset-prod/foo/specs/spec-1/acs/ac-1",
      status: "pass",
      test_identifier: "test.ts::it works",
      duration_ms: 42,
    });
    expect(payload.actor).toBeUndefined();
    expect(payload.hidden).toBeUndefined();
    expect(payload.metadata).toBeUndefined();
  });

  it("stamps actor at the top level when a fallback-chain env var is set [spec-115 dec-6 ac-25]", () => {
    tagAc(`${AC}/ac-25`);
    vi.stubEnv("GITHUB_ACTOR", "octocat");
    const payload = buildPayload({
      ac_uid: "mindset-prod/foo/specs/spec-1/acs/ac-1",
      status: "pass",
      test_identifier: "test.ts::it works",
      duration_ms: 42,
    });
    expect(payload.actor).toBe("octocat");
    // Crucially: actor lives at the top level, NOT inside metadata.
    expect(payload.metadata?.actor).toBeUndefined();
  });

  it("omits actor entirely when no fallback-chain env var is set [spec-115 dec-6 ac-26]", () => {
    tagAc(`${AC}/ac-26`);
    const payload = buildPayload({
      ac_uid: "mindset-prod/foo/specs/spec-1/acs/ac-1",
      status: "pass",
      test_identifier: "test.ts::it works",
      duration_ms: 42,
    });
    // The field is absent (not present-with-empty-string).
    expect(payload.actor).toBeUndefined();
    expect("actor" in payload).toBe(false);
  });

  it("includes hidden=true when MEMEX_HIDDEN is set", () => {
    vi.stubEnv("MEMEX_HIDDEN", "true");
    const payload = buildPayload({
      ac_uid: "mindset-prod/foo/specs/spec-1/acs/ac-1",
      status: "pass",
      test_identifier: "test.ts::it works",
      duration_ms: 42,
    });
    expect(payload.hidden).toBe(true);
  });

  it("includes hidden=true when per-call hidden:true [spec-115 scope ac-2]", () => {
    // spec-115 scope ac-2: adopters can record without it affecting the
    // displayed verification state. The hidden flag travels with the
    // payload; server-side aggregation excludes hidden events (covered
    // separately in packages/server services).
    tagAc(`${AC}/ac-2`);
    const payload = buildPayload({
      ac_uid: "mindset-prod/foo/specs/spec-1/acs/ac-1",
      status: "pass",
      test_identifier: "test.ts::it works",
      duration_ms: 42,
      options: { hidden: true },
    });
    expect(payload.hidden).toBe(true);
  });

  it("includes per-call metadata in the payload (ac-12)", () => {
    tagAc(`${AC}/ac-12`);
    const payload = buildPayload({
      ac_uid: "mindset-prod/foo/specs/spec-1/acs/ac-1",
      status: "pass",
      test_identifier: "test.ts::it works",
      duration_ms: 42,
      options: { metadata: { tenant: "acme" } },
    });
    expect(payload.metadata).toMatchObject({ tenant: "acme" });
  });

  it("transmits oversized metadata unmodified — server enforces, helper does not (ac-12)", () => {
    tagAc(`${AC}/ac-12`);
    const bigValue = "x".repeat(10_000);
    const payload = buildPayload({
      ac_uid: "mindset-prod/foo/specs/spec-1/acs/ac-1",
      status: "pass",
      test_identifier: "test.ts::it works",
      duration_ms: 42,
      options: { metadata: { huge: bigValue } },
    });
    expect(payload.metadata?.huge).toBe(bigValue);
    expect(payload.metadata?.huge?.length).toBe(10_000);
  });

  it("transmits caller-provided metadata with many keys unmodified (ac-12)", () => {
    tagAc(`${AC}/ac-12`);
    const manyKeys: Record<string, string> = {};
    for (let i = 0; i < 100; i++) {
      manyKeys[`key_${i}`] = `value_${i}`;
    }
    const payload = buildPayload({
      ac_uid: "mindset-prod/foo/specs/spec-1/acs/ac-1",
      status: "pass",
      test_identifier: "test.ts::it works",
      duration_ms: 42,
      options: { metadata: manyKeys },
    });
    expect(Object.keys(payload.metadata ?? {}).length).toBe(100);
  });
});
