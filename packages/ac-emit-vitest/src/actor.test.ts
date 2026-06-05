import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readAutoActor, tagAc } from "./index.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-115/acs";

describe("readAutoActor — env-var fallback chain (spec-115 dec-6)", () => {
  beforeEach(() => {
    // Clear every env var in the chain so each test starts from a known
    // baseline. Without these stubs, the developer's $USER leaks in.
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

  it("returns GITHUB_ACTOR when set (highest priority) [spec-115 dec-6 ac-25]", () => {
    tagAc(`${AC}/ac-25`);
    vi.stubEnv("GITHUB_ACTOR", "octocat");
    vi.stubEnv("GITLAB_USER_LOGIN", "alice");
    vi.stubEnv("USER", "wic");
    expect(readAutoActor()).toBe("octocat");
  });

  it("falls back to GITLAB_USER_LOGIN when GITHUB_ACTOR is unset [spec-115 dec-6 ac-25]", () => {
    tagAc(`${AC}/ac-25`);
    vi.stubEnv("GITLAB_USER_LOGIN", "alice");
    vi.stubEnv("USER", "wic");
    expect(readAutoActor()).toBe("alice");
  });

  it("falls back to BUILDKITE_BUILD_AUTHOR when GitHub and GitLab are unset [spec-115 dec-6 ac-25]", () => {
    tagAc(`${AC}/ac-25`);
    vi.stubEnv("BUILDKITE_BUILD_AUTHOR", "carol");
    vi.stubEnv("USER", "wic");
    expect(readAutoActor()).toBe("carol");
  });

  it("falls back to CIRCLE_USERNAME when GitHub/GitLab/BuildKite are unset [spec-115 dec-6 ac-25]", () => {
    tagAc(`${AC}/ac-25`);
    vi.stubEnv("CIRCLE_USERNAME", "bob");
    vi.stubEnv("USER", "wic");
    expect(readAutoActor()).toBe("bob");
  });

  it("falls back to USER (Unix shell) when no CI env var is set [spec-115 dec-6 ac-25]", () => {
    tagAc(`${AC}/ac-25`);
    vi.stubEnv("USER", "wic");
    expect(readAutoActor()).toBe("wic");
  });

  it("falls back to USERNAME (Windows shell) when USER is also unset [spec-115 dec-6 ac-25]", () => {
    tagAc(`${AC}/ac-25`);
    vi.stubEnv("USERNAME", "alice");
    expect(readAutoActor()).toBe("alice");
  });

  it("returns undefined when no env var in the chain is set [spec-115 dec-6 ac-26]", () => {
    tagAc(`${AC}/ac-26`);
    expect(readAutoActor()).toBeUndefined();
  });
});
