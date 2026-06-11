// Voice-guide latency instrumentation (std-14: per-domain debug log at
// packages/server/.logs/voice-latency.log).
//
// The felt latency of a voice turn is a pipeline: end-of-speech → STT final →
// retrieval → LLM time-to-first-token → TTS first audio chunk. This module logs
// one JSON line per stage event so a slow turn can be decomposed after the fact
// (`tail -f packages/server/.logs/voice-latency.log | jq`). It also records the
// Anthropic usage block per LLM turn — cache_read/cache_creation_input_tokens are
// the ground truth on whether prompt caching is actually engaging (a declared
// cache_control breakpoint below the model's minimum cacheable prefix is
// silently inert, so we measure rather than assume).
//
// On by default in dev; DEBUG_VOICE=0 silences the file sink. Mirrors
// agent/logger.ts: one file per server session, previous session kept as `.prev`.

import { appendFileSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ENABLED = process.env.DEBUG_VOICE !== "0";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_FILE = resolve(__dirname, "../../../.logs/voice-latency.log");
const PREV_LOG_FILE = LOG_FILE + ".prev";
let fileReady = false;

function ensureFileForSession(): void {
  if (fileReady) return;
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    if (existsSync(LOG_FILE)) renameSync(LOG_FILE, PREV_LOG_FILE);
  } catch {
    /* best-effort */
  }
  fileReady = true;
}

/** Append one stage event as a JSON line. Never throws; never blocks the turn. */
export function logVoiceLatency(
  stage:
    | "stt_final" // a finalized transcript left STT (the turn's starting gun)
    | "llm_turn" // one /guide chat completion: retrieval + TTFT + totals + usage
    | "tts_first_chunk" // synthesis latency to first audible audio
    | "tts_complete",
  fields: Record<string, unknown>,
): void {
  if (!ENABLED) return;
  ensureFileForSession();
  try {
    appendFileSync(
      LOG_FILE,
      JSON.stringify({ at: new Date().toISOString(), stage, ...fields }) + "\n",
    );
  } catch {
    /* best-effort */
  }
}
