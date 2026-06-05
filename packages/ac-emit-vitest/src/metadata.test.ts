import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildMetadata, tagAc } from "./index.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-115/acs";

describe("buildMetadata — CI auto-population", () => {
  beforeEach(() => {
    // Clear platform signals so each test starts from a known baseline.
    vi.stubEnv("CI", "");
    vi.stubEnv("GITHUB_ACTIONS", "");
    vi.stubEnv("GITLAB_CI", "");
    vi.stubEnv("BUILDKITE", "");
    vi.stubEnv("CIRCLECI", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("GitHub Actions: populates branch, commit, host, run_id, run_url [spec-115 scope ac-4]", () => {
    tagAc(`${AC}/ac-17`);
    // spec-115 scope ac-4: tests running in common CI environments get
    // useful metadata automatically — no helper-configuration code
    // required. GitHub Actions is one of the four canonical platforms.
    // (Actor is populated separately at the top level per dec-6 — see
    // actor.test.ts.)
    tagAc(`${AC}/ac-4`);
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.stubEnv("GITHUB_REF_NAME", "main");
    vi.stubEnv("GITHUB_SHA", "abc123def456");
    vi.stubEnv("GITHUB_RUN_ID", "789");
    vi.stubEnv("GITHUB_SERVER_URL", "https://github.com");
    vi.stubEnv("GITHUB_REPOSITORY", "mindset-ai/memex-app");

    const md = buildMetadata();
    expect(md.actor).toBeUndefined(); // moved to top-level per dec-6
    expect(md.branch).toBe("main");
    expect(md.commit).toBe("abc123def456");
    expect(md.host).toBe("ci");
    expect(md.run_id).toBe("789");
    expect(md.run_url).toBe(
      "https://github.com/mindset-ai/memex-app/actions/runs/789",
    );
  });

  it("GitHub Actions: GITHUB_HEAD_REF (PR branch) wins over GITHUB_REF_NAME", () => {
    tagAc(`${AC}/ac-17`);
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.stubEnv("GITHUB_HEAD_REF", "feat/pr-branch");
    vi.stubEnv("GITHUB_REF_NAME", "main");

    const md = buildMetadata();
    expect(md.branch).toBe("feat/pr-branch");
  });

  it("GitLab CI: populates branch, commit, host, run_id, run_url", () => {
    tagAc(`${AC}/ac-18`);
    vi.stubEnv("GITLAB_CI", "true");
    vi.stubEnv("CI_COMMIT_REF_NAME", "feat/foo");
    vi.stubEnv("CI_COMMIT_SHA", "def456");
    vi.stubEnv("CI_JOB_ID", "12345");
    vi.stubEnv("CI_JOB_URL", "https://gitlab.com/job/12345");

    const md = buildMetadata();
    expect(md.actor).toBeUndefined(); // top-level per dec-6
    expect(md.branch).toBe("feat/foo");
    expect(md.commit).toBe("def456");
    expect(md.host).toBe("ci");
    expect(md.run_id).toBe("12345");
    expect(md.run_url).toBe("https://gitlab.com/job/12345");
  });

  it("BuildKite: populates branch, commit, host, run_id, run_url", () => {
    tagAc(`${AC}/ac-19`);
    vi.stubEnv("BUILDKITE", "true");
    vi.stubEnv("BUILDKITE_BRANCH", "main");
    vi.stubEnv("BUILDKITE_COMMIT", "789abc");
    vi.stubEnv("BUILDKITE_BUILD_ID", "9876");
    vi.stubEnv("BUILDKITE_BUILD_URL", "https://buildkite.com/build/9876");

    const md = buildMetadata();
    expect(md.actor).toBeUndefined(); // top-level per dec-6
    expect(md.branch).toBe("main");
    expect(md.commit).toBe("789abc");
    expect(md.host).toBe("ci");
    expect(md.run_id).toBe("9876");
    expect(md.run_url).toBe("https://buildkite.com/build/9876");
  });

  it("CircleCI: populates branch, commit, host, run_id, run_url", () => {
    tagAc(`${AC}/ac-20`);
    vi.stubEnv("CIRCLECI", "true");
    vi.stubEnv("CIRCLE_BRANCH", "develop");
    vi.stubEnv("CIRCLE_SHA1", "xyz789");
    vi.stubEnv("CIRCLE_BUILD_NUM", "555");
    vi.stubEnv("CIRCLE_BUILD_URL", "https://circleci.com/job/555");

    const md = buildMetadata();
    expect(md.actor).toBeUndefined(); // top-level per dec-6
    expect(md.branch).toBe("develop");
    expect(md.commit).toBe("xyz789");
    expect(md.host).toBe("ci");
    expect(md.run_id).toBe("555");
    expect(md.run_url).toBe("https://circleci.com/job/555");
  });

  it("Generic CI=true only: populates host but no actor/branch/commit/run_id/run_url", () => {
    tagAc(`${AC}/ac-21`);
    vi.stubEnv("CI", "true");

    const md = buildMetadata();
    expect(md.host).toBe("ci");
    expect(md.actor).toBeUndefined();
    expect(md.branch).toBeUndefined();
    expect(md.commit).toBeUndefined();
    expect(md.run_id).toBeUndefined();
    expect(md.run_url).toBeUndefined();
  });

  it("No CI signal: branch and commit absent when no env vars present", () => {
    tagAc(`${AC}/ac-24`);
    const md = buildMetadata();
    expect(md.branch).toBeUndefined();
    expect(md.commit).toBeUndefined();
  });

  it("MEMEX_METADATA_<key> env vars override auto-populated metadata values", () => {
    tagAc(`${AC}/ac-22`);
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.stubEnv("GITHUB_REF_NAME", "from-env");
    vi.stubEnv("MEMEX_METADATA_branch", "explicit-branch");
    vi.stubEnv("MEMEX_METADATA_tenant", "acme");

    const md = buildMetadata();
    expect(md.branch).toBe("explicit-branch");
    expect(md.tenant).toBe("acme");
  });

  it("Per-call metadata overrides MEMEX_METADATA_<key> env vars", () => {
    tagAc(`${AC}/ac-22`);
    vi.stubEnv("MEMEX_METADATA_branch", "from-env");
    const md = buildMetadata({ branch: "from-call" });
    expect(md.branch).toBe("from-call");
  });

  it("MEMEX_METADATA_actor stays opaque in metadata (NOT promoted to top-level) [spec-115 dec-6 ac-29]", () => {
    // ac-29: a metadata.actor key is accepted opaquely; the canonical actor
    // is the top-level field, not metadata.actor.
    tagAc(`${AC}/ac-29`);
    vi.stubEnv("MEMEX_METADATA_actor", "metadata-actor-value");
    const md = buildMetadata();
    // The helper stores it in metadata as a customer key — buildMetadata
    // doesn't know about dec-6 semantics; the server route is where the
    // "don't promote" rule lives. Here we just confirm the helper doesn't
    // strip it.
    expect(md.actor).toBe("metadata-actor-value");
  });

  it("MEMEX_METADATA_<key> keys are lowercased", () => {
    vi.stubEnv("MEMEX_METADATA_TENANT", "acme");
    vi.stubEnv("MEMEX_METADATA_Feature_Flag", "rag_v2");
    const md = buildMetadata();
    expect(md.tenant).toBe("acme");
    expect(md.feature_flag).toBe("rag_v2");
  });
});
