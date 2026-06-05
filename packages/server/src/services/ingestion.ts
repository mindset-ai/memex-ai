import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// An IngestDispatcher decouples the MCP admin tools from how extraction
// actually gets done. Three concrete implementations:
//
//   * SubprocessDispatcher — spawns the extractor as a child process.
//     Correct for local dev, where server and extractor live in the same
//     repo and the subprocess can import them.
//
//   * InProcessDispatcher — calls the extractor's `ingest()` directly.
//     Useful for tests and single-process dev flows.
//
//   * QueueDispatcher — publishes a job to a queue (Pub/Sub / Cloud Tasks
//     / SQS). Correct for prod where the extractor runs in a separate
//     container. Stubbed here; concrete impl lives with the deploy config.
//
// The MCP layer never knows which is in play. It calls dispatch() and
// handles the outcome uniformly.

export interface IngestJob {
  memexId: string;
  repoName: string;
  folderPaths: string[];
}

export interface IngestResult {
  status: "ok" | "failed";
  exitCode?: number;
  message?: string;
}

export interface IngestDispatcher {
  dispatch(job: IngestJob): Promise<IngestResult>;
}

// ── Filesystem allow-list for the subprocess dispatcher ───────────
// The MCP `ingest_repo` tool takes arbitrary `folderPaths` from the agent.
// Without a guard, an agent can point the extractor at `/home`, `/etc`,
// `/root/.ssh` — anywhere with matching file extensions — and those files'
// contents end up in the memexId's `files.content`, readable through
// `get_file_content` and `search_content`. That is arbitrary file read.
//
// This gate enforces that every requested path canonicalises (via
// realpathSync, which follows symlinks) under one of the operator-
// configured roots. Set ALLOWED_INGEST_ROOTS to a colon-separated list
// of absolute directories. If unset, all paths are rejected (fail-closed).
//
// Prod hosting should prefer the QueueDispatcher path where ingestion is
// driven by a signed git-URL, not by a filesystem path at all — this
// allow-list is a dev-mode safety net, not a hardening primitive.
// Exported for testability. Not part of the dispatcher's public API, but
// the gate it enforces is security-critical and needs unit coverage.
export function allowedIngestRoots(rawEnv: string | undefined = process.env.ALLOWED_INGEST_ROOTS): string[] {
  if (!rawEnv) return [];
  return rawEnv
    .split(":")
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => path.resolve(p));
}

export function assertPathsAllowed(
  folderPaths: string[],
  rawEnv: string | undefined = process.env.ALLOWED_INGEST_ROOTS,
  realpath: (p: string) => string = realpathSync,
): void {
  const roots = allowedIngestRoots(rawEnv);
  if (roots.length === 0) {
    throw new Error(
      "ingest_repo rejected: ALLOWED_INGEST_ROOTS is not configured. Set it to a colon-separated list of absolute directories that ingestion may read from.",
    );
  }
  for (const raw of folderPaths) {
    let real: string;
    try {
      real = realpath(raw);
    } catch (err) {
      throw new Error(`ingest_repo rejected: path does not exist or is unreadable: ${raw}`);
    }
    const ok = roots.some((root) => real === root || real.startsWith(root + path.sep));
    if (!ok) {
      throw new Error(
        `ingest_repo rejected: ${raw} (resolved to ${real}) is outside ALLOWED_INGEST_ROOTS`,
      );
    }
  }
}

export class SubprocessDispatcher implements IngestDispatcher {
  async dispatch(job: IngestJob): Promise<IngestResult> {
    // Hard-gate every path before spawning anything.
    assertPathsAllowed(job.folderPaths);

    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    // src/services/ingestion.ts → ../../extractor
    const extractorCwd = path.resolve(__dirname, "../../../extractor");
    const args = [
      "extract",
      "--account",
      job.memexId,
      job.repoName,
      ...job.folderPaths,
    ];
    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn("pnpm", args, {
        cwd: extractorCwd,
        stdio: ["ignore", "inherit", "inherit"],
        env: process.env,
      });
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? 1));
    });
    return exitCode === 0
      ? { status: "ok", exitCode }
      : { status: "failed", exitCode, message: `extractor exit code ${exitCode}` };
  }
}

export class QueueDispatcher implements IngestDispatcher {
  // Stub. In prod this publishes to Cloud Pub/Sub (or equivalent), returns
  // immediately with a job id, and the extractor container subscribes.
  // Leaving as NotImplemented so production wiring is an explicit future
  // task and doesn't silently fall through to SubprocessDispatcher.
  async dispatch(_job: IngestJob): Promise<IngestResult> {
    throw new Error(
      "QueueDispatcher not implemented. Configure your queue in services/ingestion.ts and wire it up before deploying the server beyond local dev.",
    );
  }
}

// Default dispatcher, resolved once at module load. Reading the env per
// request would mean a half-flipped config state could let some requests
// go to subprocess and others to queue; resolving once at startup pins the
// choice for the lifetime of the process. Tests inject their own dispatcher
// by calling ingestion entry points directly (ingestion is no longer an
// MCP tool — see FEAT.md §7).
let cachedDefaultDispatcher: IngestDispatcher | null = null;

export function defaultDispatcher(): IngestDispatcher {
  if (cachedDefaultDispatcher) return cachedDefaultDispatcher;
  const mode = process.env.INGEST_DISPATCH_MODE ?? "subprocess";
  switch (mode) {
    case "subprocess":
      cachedDefaultDispatcher = new SubprocessDispatcher();
      break;
    case "queue":
      cachedDefaultDispatcher = new QueueDispatcher();
      break;
    default:
      throw new Error(`Unknown INGEST_DISPATCH_MODE: ${mode}`);
  }
  return cachedDefaultDispatcher;
}
