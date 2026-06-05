/**
 * Well-known metadata key auto-population from process.env.
 *
 * The helper recognises four canonical CI platforms (GitHub Actions, GitLab
 * CI, BuildKite, CircleCI) plus generic `CI=true` for the `host` key. For
 * each platform, the helper reads the documented env vars and populates the
 * corresponding well-known keys.
 *
 * Customers extend metadata via `MEMEX_METADATA_<key>=<value>` env vars
 * (read here) or via per-call options to tagAc (handled in emit.ts).
 *
 * Merge order (later wins): auto-populated CI keys < MEMEX_METADATA_* env
 * vars < per-call explicit metadata.
 *
 * Note (spec-115 dec-6): `actor` is NOT in this map. Actor is a top-level
 * wire-format field, not a metadata key — see `actor.ts`.
 */

/** Read auto-populated well-known keys from process.env. */
function readAutoPopulated(): Record<string, string> {
  const out: Record<string, string> = {};
  const env = process.env;

  // host: generic CI signal sets host=ci even when no platform-specific
  // signal is present (e.g. self-hosted runners that only set CI=true).
  const isGenericCi = env.CI === "true" || env.CI === "1";
  if (isGenericCi) {
    out.host = "ci";
  }

  if (env.GITHUB_ACTIONS === "true") {
    const branch = env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME;
    if (branch) out.branch = branch;
    if (env.GITHUB_SHA) out.commit = env.GITHUB_SHA;
    out.host = "ci";
    if (env.GITHUB_RUN_ID) out.run_id = env.GITHUB_RUN_ID;
    if (env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID) {
      out.run_url = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
    }
  }

  if (env.GITLAB_CI === "true") {
    if (env.CI_COMMIT_REF_NAME) out.branch = env.CI_COMMIT_REF_NAME;
    if (env.CI_COMMIT_SHA) out.commit = env.CI_COMMIT_SHA;
    out.host = "ci";
    if (env.CI_JOB_ID) out.run_id = env.CI_JOB_ID;
    if (env.CI_JOB_URL) out.run_url = env.CI_JOB_URL;
  }

  if (env.BUILDKITE === "true") {
    if (env.BUILDKITE_BRANCH) out.branch = env.BUILDKITE_BRANCH;
    if (env.BUILDKITE_COMMIT) out.commit = env.BUILDKITE_COMMIT;
    out.host = "ci";
    if (env.BUILDKITE_BUILD_ID) out.run_id = env.BUILDKITE_BUILD_ID;
    if (env.BUILDKITE_BUILD_URL) out.run_url = env.BUILDKITE_BUILD_URL;
  }

  if (env.CIRCLECI === "true") {
    if (env.CIRCLE_BRANCH) out.branch = env.CIRCLE_BRANCH;
    if (env.CIRCLE_SHA1) out.commit = env.CIRCLE_SHA1;
    out.host = "ci";
    if (env.CIRCLE_BUILD_NUM) out.run_id = env.CIRCLE_BUILD_NUM;
    if (env.CIRCLE_BUILD_URL) out.run_url = env.CIRCLE_BUILD_URL;
  }

  return out;
}

/** Read all `MEMEX_METADATA_<key>=<value>` env vars from process.env. */
function readEnvMetadata(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [envKey, envVal] of Object.entries(process.env)) {
    if (envKey.startsWith("MEMEX_METADATA_") && envVal !== undefined) {
      const key = envKey.slice("MEMEX_METADATA_".length).toLowerCase();
      if (key) out[key] = envVal;
    }
  }
  return out;
}

/**
 * Build the metadata for an emission.
 *
 * Merge order (later wins): auto-populated < MEMEX_METADATA_* env vars <
 * explicit per-call.
 */
export function buildMetadata(
  explicit?: Record<string, string>,
): Record<string, string> {
  const auto = readAutoPopulated();
  const env = readEnvMetadata();
  return { ...auto, ...env, ...(explicit ?? {}) };
}
