/**
 * Per-domain debug logger factory [per std-14].
 *
 * std-14 says every cross-cutting server subsystem (auth, MCP, future Slack
 * ingestion, …) should write structured multi-line blocks to console AND to its
 * own append-only `packages/server/.logs/<domain>.log`, gated by a
 * `DEBUG_<DOMAIN>` env var, rotating the prior session to `.log.prev` on the
 * first call after process start. Before spec-356 that mechanism lived ONLY
 * inside `agent/logger.ts`, so every new subsystem had to copy-paste it (and 120
 * ad-hoc `console.*` calls across resolver/mcp/services/routes never adopted it
 * at all — cq-5). This factory extracts the mechanism once, typed, so a new
 * domain logger is one call instead of a re-implementation.
 *
 * What this factory gives you (the std-14 mechanics, cl-5..cl-10):
 *   - co-located, one-call construction: `const log = createDomainLogger("auth")`
 *   - console + file fan-out to `packages/server/.logs/<domain>.log`
 *   - `.log.prev` rotation on first write after process start (one generation)
 *   - `DEBUG_<DOMAIN>` gating, default ON in dev, OFF unless any non-`0` value
 *   - the `┌─ │ └─` block format, so every domain log greps the same way
 *
 * What it does NOT do — the caller's responsibility (cl-12/cl-13): NEVER pass
 * secrets (JWTs, passwords, scrypt output, raw Anthropic/Postmark keys, `mxt_…`
 * token values — only the `prefix` is safe). Redact `Authorization` headers and
 * the like in the BODY you hand to `.block(...)`, exactly as `agent/logger.ts`
 * does.
 *
 * `packages/server/.logs/` is git-ignored (cl-14); CI never reads it (cl-15);
 * production observability is Cloud Run logs, not these files (cl-30).
 *
 * Existing loggers (`agent/logger.ts`) predate this factory and keep their own
 * domain-shaped helpers; migrating them onto this base is opportunistic
 * follow-up, not required (their public API must not change).
 */
import { appendFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** A typed per-domain logger. `enabled` lets a caller cheaply guard expensive
 * body construction; `block` writes one std-14 block to console + file. */
export interface DomainLogger {
  /** True when `DEBUG_<DOMAIN>` is not `0` — gate expensive formatting on this. */
  readonly enabled: boolean;
  /**
   * Write one std-14 block:
   *   ┌─ [DOMAIN <label>] <ISO timestamp> — <summary>
   *   │ <body>
   *   └─ (end <label>)
   * `body` may be multi-line. No-op when the logger is disabled.
   */
  block(label: string, summary: string, body?: string): void;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Build a std-14 per-domain logger.
 *
 * @param domain lower-case domain slug, e.g. `"auth"` → `DEBUG_AUTH`,
 *   `packages/server/.logs/auth.log`. The console label is upper-cased.
 */
export function createDomainLogger(domain: string): DomainLogger {
  const envKey = `DEBUG_${domain.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  const enabled = process.env[envKey] !== "0";
  const consoleLabel = domain.toUpperCase();

  const logFile = resolve(__dirname, `../../.logs/${domain}.log`);
  const prevLogFile = `${logFile}.prev`;
  let fileReady = false;

  function ensureFileForSession(): void {
    if (fileReady) return;
    try {
      mkdirSync(dirname(logFile), { recursive: true });
      if (existsSync(logFile)) {
        // Keep exactly one prior generation (cl-8/cl-28).
        renameSync(logFile, prevLogFile);
      }
    } catch {
      // best-effort — console logging still works
    }
    fileReady = true;
  }

  function writeToFile(line: string): void {
    ensureFileForSession();
    try {
      appendFileSync(logFile, `${line}\n`);
    } catch {
      // ignore file-system errors — console logging continues regardless
    }
  }

  return {
    enabled,
    block(label: string, summary: string, body = ""): void {
      if (!enabled) return;
      const ts = new Date().toISOString();
      const bodyLines = body
        .split("\n")
        .map((l) => `│ ${l}`)
        .join("\n");
      const out = `\n┌─ [${consoleLabel} ${label}] ${ts} — ${summary}${
        body ? `\n${bodyLines}` : ""
      }\n└─ (end ${label})`;
      console.log(out);
      writeToFile(out);
    },
  };
}
