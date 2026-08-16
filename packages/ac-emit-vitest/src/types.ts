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
   * Top-level sibling of `metadata` because it is part of the cross-table
   * activity contract, not free-form observational provenance.
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
   * The CI run this emission came from, and the commit it ran against
   * (spec-528 t-4). Top-level siblings of `metadata` because the wire format
   * declares them there and the server stores them in dedicated columns — they
   * are attribution, not free-form provenance, and [per std-32] cl-8 a field a
   * consumer reads to attribute MUST be a column.
   *
   * Derived from the same CI detection that populates `metadata.run_id` /
   * `metadata.commit` (see metadata.ts), so every provider already supported is
   * covered and a per-call override is honoured. **Note the name difference
   * across the boundary: the wire field is `commit_sha`, the metadata key is
   * `commit`.** Reversing the two is a silent no-op.
   *
   * Omitted entirely when no CI environment supplies them, so the server stores
   * NULL rather than an empty string — an empty top-level value would WIN over a
   * good metadata one under the server's precedence rule (spec-528 dec-1).
   *
   * The metadata copies are kept alongside on purpose (spec-528 ac-3): external
   * readers learned `metadata->>'run_id'` during the months the columns were
   * empty, and `branch` / `run_url` have no column at all.
   */
  run_id?: string;
  /** The commit SHA the test ran against — see {@link AcEventPayload.run_id}. */
  commit_sha?: string;
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
  metadata?: Record<string, string>;
}
