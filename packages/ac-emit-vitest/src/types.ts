/**
 * Wire format for AC test event emissions.
 *
 * Posted to `<canonical-host>/api/test-events` when a tagged test finishes.
 * Server-side aggregation reads these to determine AC verification state.
 *
 * ⚠ PROTOCOL CONTRACT — this wire shape is also documented, language-agnostically, in the
 * `ac-emission-bootstrap` get_information topic
 * (packages/server/src/guidance/ac-emission-bootstrap.json) so codebases without an
 * official helper can hand-roll a correct emitter. If you add/rename/retype a field here,
 * update that topic too, or non-JS emitters silently drift from the protocol.
 */
export interface AcEventPayload {
  /** Canonical AC ref: `<namespace>/<memex>/specs/<spec-N>/acs/ac-<N>`. */
  ac_uid: string;
  /** Test outcome reported by the framework. */
  status: "pass" | "fail" | "error";
  /** Free-form test identifier (typically `file::name`). */
  test_identifier: string;
  /** Test duration in milliseconds. */
  duration_ms: number;
  /**
   * Actor — WHO ran the test (spec-115 dec-6, spec-122 activity contract).
   * Top-level sibling of `hidden` and `metadata` because it is part of the
   * cross-table activity contract, not free-form observational provenance.
   *
   * Helper auto-populates from a documented env-var fallback chain:
   * `GITHUB_ACTOR` → `GITLAB_USER_LOGIN` → `BUILDKITE_BUILD_AUTHOR` →
   * `CIRCLE_USERNAME` → `USER` → `USERNAME`. When no env var is set the
   * field is omitted from the payload and lands as NULL server-side.
   *
   * A `metadata.actor` key (legacy hand-rolled wire format) is accepted
   * opaquely as metadata but is NOT promoted into this field server-side.
   * The canonical actor is the top-level field.
   */
  actor?: string;
  /**
   * Hidden flag (v0.1.0). When true, the emission is recorded but excluded
   * from the AC's displayed verification state. Default false.
   */
  hidden?: boolean;
  /**
   * Extensible metadata bag (v0.1.0). Surfaced in the Memex UI tooltip on
   * each test event. Well-known keys (actor, branch, commit, host, run_id,
   * run_url) render specially; unknown keys render as plain key-value pairs.
   *
   * Server-side caps: ~4KB total, 32 keys, 256 chars per value. Exceeding
   * keys are dropped server-side and named in the `X-Memex-Warning`
   * response header; the verification signal still lands.
   *
   * Metadata is visible to anyone who can read the Memex, including
   * anonymous visitors on public Memexes. Do not put sensitive values here.
   */
  metadata?: Record<string, string>;
}

/** Per-call options for tagAc. */
export interface TagAcOptions {
  hidden?: boolean;
  metadata?: Record<string, string>;
}
