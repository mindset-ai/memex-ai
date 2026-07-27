// Types for e2e-preflight.mjs (spec-512 dec-3). See workspace-alloc.d.mts for why
// the implementation is an untyped `.mjs` and this declaration exists.

/** How the thing currently listening on our e2e port is classified.
 *  Only `free` and `own` are safe to proceed on. */
export type PortOwnerVerdict =
  | { kind: "free" }
  | { kind: "own" }
  | { kind: "unidentified" }
  | { kind: "foreign"; reason: "mismatch" | "non-json"; seen?: string };

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
      reason: "missing" | "empty" | "older-than-src";
      distTime?: number;
      srcTime?: number;
    };

export function isStaleBuild(
  distDir: string,
  srcDir: string,
  opts?: { listFiles?: (dir: string) => string[] },
): StaleBuildVerdict;

export function needsPgPassword(args: {
  env: Record<string, string | undefined>;
  runPsql: () => unknown;
}): boolean;
