// spec-150 dec-6: single-pass LLM clause translator.
//
// Takes ONE section's content (optionally the full standard as context) and returns
// that section's clauses, in order — rewording compound sentences into one-aspect
// clauses where needed (dec-7: meaning-preserving reword). The section's content then
// becomes the ordered concatenation of these clauses (partition invariant, dec-1).
//
// Uses Anthropic STRUCTURED OUTPUTS — `messages.parse` with `output_config.format =
// zodOutputFormat(schema)`. The JSON Schema constrains decoding, so `clauses` is
// guaranteed to come back as an array of strings (no tool-use best-effort flakiness,
// no retry needed). Server-side via getAnthropicClient(); the client is injectable so
// tests run key-free with a stub.

import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { getAnthropicClient } from "../agent/anthropic-client.js";
import { CLAUSE_TRANSLATOR_PROMPT } from "@memex/shared";

// Sonnet 4.5 — the clause-translator (and bulk decomposition migration) runs on this.
// N==1 (std-17) showed 4.6 worse here: it retained `- ` list markers and mangled an
// embedded quote on a mid-quote split; 4.5 produced a clean partition. Same model the
// chat route uses (routes/llm.ts).
const MODEL = "claude-sonnet-4-5-20250929";

// Structured-output contract: the section's clauses, in document order. Concatenated
// in order they ARE the section's content. (Kept to a plain string array so the JSON
// Schema is one Anthropic constrains cleanly; non-empty is checked after parse.)
export const ClauseTranslationSchema = z.object({
  clauses: z.array(z.string()),
});
export type ClauseTranslation = z.infer<typeof ClauseTranslationSchema>;

// Minimal Anthropic surface the translator uses (messages.parse with structured
// outputs), so tests can inject a stub client.
export interface AnthropicLike {
  messages: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parse: (args: any) => Promise<{ parsed_output: ClauseTranslation | null }>;
  };
}

export interface TranslateOptions {
  /** The full standard, passed as context only (the model still splits just the section). */
  fullDoc?: string;
  /** Injected client for tests; defaults to the shared Anthropic client. */
  client?: AnthropicLike;
}

/**
 * Translate one section's content into an ordered list of clause bodies.
 * Throws if structured output is absent or empty. Callers compose + persist.
 */
export async function translateSectionToClauses(
  sectionContent: string,
  opts: TranslateOptions = {},
): Promise<string[]> {
  const client = opts.client ?? (getAnthropicClient() as unknown as AnthropicLike);

  const userContent = opts.fullDoc
    ? `Full standard (context only — do NOT split this):\n\n${opts.fullDoc}\n\n---\n\nSplit ONLY this section into clauses:\n\n${sectionContent}`
    : `Split this section into clauses:\n\n${sectionContent}`;

  const message = await client.messages.parse({
    model: MODEL,
    max_tokens: 4096,
    system: CLAUSE_TRANSLATOR_PROMPT,
    output_config: { format: zodOutputFormat(ClauseTranslationSchema) },
    messages: [{ role: "user", content: userContent }],
  });

  if (!message.parsed_output) {
    throw new Error("clause-translator: structured output returned no parsed_output");
  }
  const clauses = message.parsed_output.clauses.filter((c) => c.trim().length > 0);
  if (clauses.length === 0) {
    throw new Error("clause-translator: structured output returned zero clauses");
  }
  return clauses;
}
