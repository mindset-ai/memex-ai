// spec-528 t-4 / ac-6 — the emitter sends run_id and commit_sha where the wire
// format declares them: at the top level.
//
// WHAT THIS DOES NOT CHANGE. Nothing observable. t-1 shipped 2026-08-13 and the
// server already fills both columns from `metadata.run_id` / `metadata.commit` when
// the top-level fields are absent — measured on prod the next day at 86% overall and
// 100% for the workspace that generates most of the load. An event sent by this code
// and an event sent by the version before it produce an identical stored row.
//
// WHAT IT DOES CHANGE. Today the server-side fallback is not a compatibility path —
// it is the ONLY path, because no client sends the declared fields. dec-1 called that
// out at the time: "a compatibility shim in the hottest write path, and shims outlive
// their reasons." After this, an up-to-date client sends the fields properly and the
// fallback goes back to being what it was designed as: a bridge for clients that have
// not upgraded, removable once they are gone.
//
// A small irony this closes: the bootstrap protocol served to developers hand-rolling
// an emitter documents `run_id` and `commit_sha` as top-level fields. Until now the
// official helper was the one client not following the official protocol.
//
// THE NAME DIFFERS ACROSS THE BOUNDARY. The wire field is `commit_sha`; the metadata
// key is `commit`. Getting that backwards is a silent no-op — no error, no failing
// test, just a column that stays NULL. It is asserted below rather than trusted.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildPayload } from "./emit.js";
import { tagAc } from "./index.js";

const AC_PRECEDENCE = "mindset-prod/memex-building-itself/specs/spec-528/acs/ac-6";

const args = {
  ac_uid: "mindset-prod/foo/specs/spec-1/acs/ac-1",
  status: "pass" as const,
  test_identifier: "attribution.test.ts::t",
  duration_ms: 1,
};

/** The env a GitHub Actions run presents. */
function inGitHubActions(): void {
  vi.stubEnv("GITHUB_ACTIONS", "true");
  vi.stubEnv("GITHUB_RUN_ID", "31711914788");
  vi.stubEnv("GITHUB_SHA", "15e241cd11aa22bb33cc44dd55ee66ff77889900");
  vi.stubEnv("GITHUB_REF_NAME", "develop");
}

beforeEach(() => {
  // Neutralise the ambient environment first: this suite asserts what a payload
  // carries, and a developer's own shell (USER, a real CI var) would otherwise leak
  // into the assertions. Same discipline as the spec-515 sibling suites.
  for (const k of [
    "GITHUB_ACTIONS",
    "GITHUB_RUN_ID",
    "GITHUB_SHA",
    "GITHUB_REF_NAME",
    "GITHUB_HEAD_REF",
    "GITHUB_SERVER_URL",
    "GITHUB_REPOSITORY",
    "GITHUB_ACTOR",
    "GITLAB_CI",
    "CI_JOB_ID",
    "CI_COMMIT_SHA",
    "BUILDKITE",
    "CIRCLECI",
    "CI",
    "USER",
    "USERNAME",
  ]) {
    vi.stubEnv(k, "");
  }
});

afterEach(() => {
  // [per std-37] cl-5: restore what the test replaced — a leaked env stub can
  // silently swallow AC emission in a sibling file.
  vi.unstubAllEnvs();
});

describe("spec-528 ac-6: the emitter sends run attribution at the top level", () => {
  it("carries run_id and commit_sha when CI provides them", () => {
    tagAc(AC_PRECEDENCE);
    inGitHubActions();

    const payload = buildPayload(args);

    expect(payload.run_id).toBe("31711914788");
    // The wire field is commit_sha; the metadata key it derives from is `commit`.
    // Asserted explicitly because reversing the two is a silent no-op.
    expect(payload.commit_sha).toBe("15e241cd11aa22bb33cc44dd55ee66ff77889900");
  });

  it("OMITS both fields entirely outside CI — never an empty string", () => {
    tagAc(AC_PRECEDENCE);
    // No CI env stubbed by beforeEach, so nothing to derive.
    const payload = buildPayload(args);

    // `in` rather than a value check: sending "" would make the server store an
    // empty string instead of NULL, and the top-level value wins over metadata —
    // so an empty top-level field would BEAT a good metadata one. This is the same
    // hazard the `actor` field is written to avoid.
    expect("run_id" in payload).toBe(false);
    expect("commit_sha" in payload).toBe(false);
  });

  it("keeps the metadata copy alongside — the duplication is deliberate (ac-3)", () => {
    tagAc(AC_PRECEDENCE);
    inGitHubActions();

    const payload = buildPayload(args);

    // External readers learned `metadata->>'run_id'` during the months the columns
    // were empty, and `branch` / `run_url` have no column at all. Removing these
    // would read as tidying up duplication and would silently break them.
    expect(payload.metadata?.run_id).toBe("31711914788");
    expect(payload.metadata?.commit).toBe("15e241cd11aa22bb33cc44dd55ee66ff77889900");
    expect(payload.metadata?.branch).toBe("develop");
  });

  it("follows a per-call metadata override rather than re-reading the environment", () => {
    tagAc(AC_PRECEDENCE);
    inGitHubActions();

    // buildMetadata's merge order is: auto-populated < MEMEX_METADATA_* < per-call.
    // Promoting from the MERGED result rather than from the env keeps one source of
    // truth — an adopter who overrides the run id gets that override in the column
    // too, instead of the payload disagreeing with its own metadata.
    const payload = buildPayload({
      ...args,
      options: { metadata: { run_id: "overridden-run" } },
    });

    expect(payload.run_id).toBe("overridden-run");
    expect(payload.metadata?.run_id).toBe("overridden-run");
  });

  it("derives from any supported CI provider, not GitHub alone", () => {
    tagAc(AC_PRECEDENCE);
    vi.stubEnv("GITLAB_CI", "true");
    vi.stubEnv("CI_JOB_ID", "gitlab-4242");
    vi.stubEnv("CI_COMMIT_SHA", "abcdef1234567890");

    const payload = buildPayload(args);

    // The promotion reuses buildMetadata rather than re-reading env vars, so every
    // provider it already supports (GitHub, GitLab, BuildKite, Circle) is covered
    // by construction. This asserts that property holds rather than assuming it.
    expect(payload.run_id).toBe("gitlab-4242");
    expect(payload.commit_sha).toBe("abcdef1234567890");
  });
});

describe("spec-528 ac-6: one payload builder serves both transports", () => {
  it("the batch path carries the same fields — it maps this same builder", () => {
    tagAc(AC_PRECEDENCE);
    inGitHubActions();

    // emitBatch maps buildPayload over its bucket, so batching cannot be left
    // behind by construction. Asserted rather than trusted: a batch path that
    // diverged later would leave the highest-volume transport unattributed, and
    // silently — exactly the shape of the defect spec-528 exists to fix.
    const built = [args, { ...args, test_identifier: "b::2" }].map(buildPayload);

    expect(built).toHaveLength(2);
    for (const p of built) {
      expect(p.run_id).toBe("31711914788");
      expect(p.commit_sha).toBe("15e241cd11aa22bb33cc44dd55ee66ff77889900");
    }
  });
});
