// Types for e2e-preflight.mjs (spec-512 dec-3). See workspace-alloc.d.mts for why
// the implementation is an untyped `.mjs` and this declaration exists.

/** How the thing currently listening on our e2e port is classified.
 *  Only `free` and `own` are safe to proceed on. */
export type PortOwnerVerdict =
  | { kind: "free" }
  | { kind: "own" }
  | {
      kind: "unidentified";
      reason: "timeout" | "non-json" | "unhealthy" | "no-id";
    }
  | { kind: "foreign"; reason: "mismatch" | "non-json"; seen?: string };

/** The ports a run must clear. Exported so coverage can be asserted from the
 *  DATA rather than by counting call sites in the source (which was defeatable
 *  by a conditional or a string literal). */
export function portsToCheck(cfg: {
  apiPort: number;
  uiPort: number;
}): Array<{ port: number; label: string }>;

export function classifyPortOwner(args: {
  port: number;
  expectedWorkspaceId: string;
  /** Injected so the guard's own tests can drive every branch without sockets.
   *  Resolves to the parsed /api/health body, or null when nothing is listening. */
  probe: (port: number) => Promise<unknown>;
}): Promise<PortOwnerVerdict>;

export type StaleBuildVerdict =
  | { stale: false }
  | {
      stale: true;
      reason: "missing" | "empty" | "older-than-src" | "incomplete";
      distTime?: number;
      srcTime?: number;
      /** `incomplete`: source modules with no emitted counterpart. */
      missingCount?: number;
      srcCount?: number;
      example?: string;
    };

export function isStaleBuild(
  distDir: string,
  srcDir: string,
  opts?: { listFiles?: (dir: string) => string[] },
): StaleBuildVerdict;

/** `examined: false` means we learned nothing (psql absent / Postgres down) — the
 *  caller must NOT count it as a check that passed. */
export function needsPgPassword(args: {
  env: Record<string, string | undefined>;
  runPsql: () => unknown;
}): { blocked: boolean; examined: boolean; why?: string };

// ── spec-524: can the target Postgres replay the migrations? ─────────────────

/** What one probe round trip learned. `unreachable` means psql was absent,
 *  Postgres was down, or credentials were refused — we learned nothing. */
export type PgCapabilityReading =
  | { version: string; vectorAvailable: boolean; port: string | null }
  | { unreachable: true; why?: string };

/** `examined: false` means the probe learned nothing, so the caller must NOT
 *  count it as a check that passed — the same discipline as needsPgPassword.
 *  `ok: true` with `examined: false` is an abstention, not an endorsement. */
export type PgCapabilityVerdict =
  | { ok: true; examined: true }
  | { ok: true; examined: false; why: string }
  | { ok: false; examined: true; version: string; port: string };

export function classifyPgCapability(
  reading: PgCapabilityReading | null | undefined,
): PgCapabilityVerdict;

/** The refusal a developer reads. Pure and exported because ac-13 is a claim
 *  about WORDS: asserting it end-to-end would depend on which Postgres this
 *  machine happens to run, and CI's differs from a workstation's. */
export function describePgCapabilityFailure(verdict: {
  version: string;
  port: string;
}): string;

/** The notice a bypassed run carries, on both the clean and the failing path. */
export function describeCapabilityBypass(names: string[]): string;

/** The one query, exported so a test can assert the port is asked OF THE SERVER
 *  (`inet_server_port()`) rather than recomputed from the environment. */
export const PG_CAPABILITY_QUERY: string;

/** The single, narrow escape hatch: it disarms the capability probe and nothing
 *  else. There is deliberately no variable that disables the preflight. */
export const PG_CAPABILITY_BYPASS: string;
