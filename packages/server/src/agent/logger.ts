/**
 * Agent conversation logging.
 *
 * Prints each LLM round-trip to stdout AND appends to a persistent log file at
 * `packages/server/.logs/agent.log` so runs survive terminal scrollback. On by
 * default in dev; toggle with DEBUG_AGENT=0 to silence both sinks.
 *
 * Designed for diagnosing agent behaviour at the prompt level — e.g. why a
 * particular tool_result yields an empty response turn.
 */
import { appendFileSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  MessageParam,
  ContentBlockParam,
  Message,
} from "@anthropic-ai/sdk/resources/messages.js";

const ENABLED = process.env.DEBUG_AGENT !== "0";

// File lives at packages/server/.logs/agent.log — alongside the server, easy
// for the dev loop to tail. One file per server session: on first log call
// after process start we rotate the previous session's log to `.prev` and
// start a fresh `agent.log`. With `tsx watch` restarting on code changes,
// this means each dev iteration gets a clean file without losing the one
// immediately before it.
const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_FILE = resolve(__dirname, "../../.logs/agent.log");
const PREV_LOG_FILE = LOG_FILE + ".prev";
let fileReady = false;

function ensureFileForSession(): void {
  if (fileReady) return;
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    if (existsSync(LOG_FILE)) {
      // Move the last session's log aside, keep one generation.
      renameSync(LOG_FILE, PREV_LOG_FILE);
    }
  } catch {
    // best-effort — stdout logging still works
  }
  fileReady = true;
}

function writeToFile(line: string): void {
  ensureFileForSession();
  try {
    appendFileSync(LOG_FILE, line + "\n");
  } catch {
    // ignore file-system errors — stdout logging continues regardless
  }
}

function emit(block: string): void {
  console.log(block);
  writeToFile(block);
}

const MAX_TEXT_PREVIEW = 400;

function truncate(s: string, n = MAX_TEXT_PREVIEW): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + ` … (${s.length - n} more chars)`;
}

function formatContentBlock(b: ContentBlockParam | Message["content"][number]): string {
  if (b.type === "text") {
    return `  text: ${truncate(b.text.replace(/\s+/g, " ").trim())}`;
  }
  if (b.type === "tool_use") {
    return `  tool_use[${b.name}] id=${b.id}\n    input=${truncate(JSON.stringify(b.input), 600)}`;
  }
  if (b.type === "tool_result") {
    const content =
      typeof b.content === "string"
        ? b.content
        : JSON.stringify(b.content);
    return `  tool_result id=${b.tool_use_id}${b.is_error ? " [ERROR]" : ""}\n    ${truncate(content)}`;
  }
  return `  ${b.type} (unhandled)`;
}

function formatMessage(m: MessageParam, idx: number): string {
  const header = `[${idx}] ${m.role.toUpperCase()}`;
  if (typeof m.content === "string") {
    return `${header}\n  ${truncate(m.content.replace(/\s+/g, " ").trim())}`;
  }
  const blocks = m.content.map(formatContentBlock).join("\n");
  return `${header}\n${blocks}`;
}

/** Called right before the LLM is invoked. Logs the full inbound conversation. */
export function logRequest(label: string, messages: MessageParam[]): void {
  if (!ENABLED) return;
  const ts = new Date().toISOString();
  emit(
    `\n┌─ [AGENT ${label}] ${ts} — ${messages.length} message${messages.length === 1 ? "" : "s"} → LLM\n${messages
      .map(formatMessage)
      .join("\n")}\n└─ (end request)`
  );
}

/** Called once the LLM's final message is available. Logs all content blocks. */
export function logResponse(label: string, final: Message): void {
  if (!ENABLED) return;
  const ts = new Date().toISOString();
  const blocks = final.content.map(formatContentBlock).join("\n");
  emit(
    `\n┌─ [AGENT ${label}] ${ts} — LLM response (stop_reason=${final.stop_reason})\n${
      blocks || "  (no content blocks returned)"
    }\n└─ (end response)\n`
  );
}

/** Logs any error surfaced during streaming / API call. */
export function logError(label: string, err: unknown): void {
  if (!ENABLED) return;
  const ts = new Date().toISOString();
  let msg = err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ""}` : String(err);
  // Include cause stack if present (e.g. AnthropicError wrapping an original error)
  if (err instanceof Error && (err as unknown as { cause?: unknown }).cause instanceof Error) {
    const cause = (err as unknown as { cause: Error }).cause;
    msg += `\n[cause] ${cause.name}: ${cause.message}\n${cause.stack ?? ""}`;
  }
  emit(`\n┌─ [AGENT ${label}] ${ts} — ERROR\n${msg}\n└─ (end error)\n`);
}

/**
 * Logs a per-turn observation of whether the agent emitted a candidate-decision
 * `create_decision` tool_use block (status='candidate') in this round-trip.
 * Greppable: `extraction:fired` / `extraction:skipped`. Helpful for tracing why
 * a candidate decision did or did not appear after a chat turn.
 *
 * Per doc-14 the legacy `propose_decision` tool was folded into
 * `create_decision({ status: 'candidate', options })`.
 */
export function logExtractionOutcome(
  label: string,
  final: Message,
  context: { docId: string | null }
): void {
  if (!ENABLED) return;
  const ts = new Date().toISOString();
  const docTag = context.docId ?? "none";
  const proposeBlocks = final.content.filter(
    (b): b is Extract<Message["content"][number], { type: "tool_use" }> => {
      if (b.type !== "tool_use" || b.name !== "create_decision") return false;
      const input = (b.input ?? {}) as Record<string, unknown>;
      return input.status === "candidate";
    },
  );
  if (proposeBlocks.length === 0) {
    emit(
      `\n┌─ [AGENT ${label}] ${ts} — extraction:skipped doc=${docTag}\n  (no candidate create_decision call)\n└─ (end extraction:skipped)\n`
    );
    return;
  }
  const lines = proposeBlocks.map((b) => {
    const input = (b.input ?? {}) as Record<string, unknown>;
    const title = typeof input.title === "string" ? input.title : "(no title)";
    const opts = Array.isArray(input.options) ? input.options.length : 0;
    return `  "${truncate(title, 120)}" (${opts} options)`;
  });
  emit(
    `\n┌─ [AGENT ${label}] ${ts} — extraction:fired doc=${docTag}\n${lines.join("\n")}\n└─ (end extraction:fired)\n`
  );
}

/** Logs a server-side tool execution (name, input, result, or error). */
export function logToolExecution(
  toolName: string,
  input: Record<string, unknown>,
  outcome: { result: string } | { error: string }
): void {
  if (!ENABLED) return;
  const ts = new Date().toISOString();
  const inputStr = truncate(JSON.stringify(input), 600);
  const outcomeStr =
    "result" in outcome
      ? `result=${truncate(outcome.result, 400)}`
      : `ERROR=${outcome.error}`;
  emit(`\n┌─ [AGENT tool] ${ts} — execute ${toolName}\n  input=${inputStr}\n  ${outcomeStr}\n└─ (end tool)\n`);
}
