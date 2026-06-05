/**
 * Actor auto-population from process.env.
 *
 * spec-115 dec-6 + spec-122 activity contract: `actor` is a first-class
 * top-level field on the wire format, not a metadata key. The helper reads
 * a documented env-var fallback chain and stamps the first non-empty value
 * at the top level of the payload. When no env var is set, the field is
 * omitted entirely (lands as NULL server-side).
 *
 * The fallback chain is deliberately fixed and documented so adopters can
 * reason about which value will be used in their environment. It starts
 * with the CI platform vars (because CI is where actor matters most) and
 * falls back to local shell defaults.
 */

/**
 * Read the actor from process.env using the documented fallback chain.
 * Returns the first non-empty string in priority order, or undefined when
 * no env var in the chain is set.
 *
 * Priority order:
 *   1. GITHUB_ACTOR         (GitHub Actions)
 *   2. GITLAB_USER_LOGIN    (GitLab CI)
 *   3. BUILDKITE_BUILD_AUTHOR (BuildKite)
 *   4. CIRCLE_USERNAME      (CircleCI)
 *   5. USER                 (Unix-style local shell)
 *   6. USERNAME             (Windows local shell)
 */
export function readAutoActor(): string | undefined {
  const env = process.env;
  return (
    env.GITHUB_ACTOR ||
    env.GITLAB_USER_LOGIN ||
    env.BUILDKITE_BUILD_AUTHOR ||
    env.CIRCLE_USERNAME ||
    env.USER ||
    env.USERNAME ||
    undefined
  );
}
