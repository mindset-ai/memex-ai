// spec-151 dec-6 — the clause→testability classifier (the LLM ENGINE) + memex backfill.
//
// dec-6 / spec-340 dec-8: classification is AGENT-DRIVEN. The ONLY server caller of this
// engine is the local, operator-run backfill script (scripts/backfill-testability.ts) and
// tests — NO server request/write path imports it (enforced by
// testability-classifier-no-request-path.regression.test.ts). The authoring hooks
// (add_clause / edit_clause) persist an agent-SUPPLIED verdict via the request-path-safe
// services/testability.ts; they never call this engine.
//
// Mirrors facet-classifier.ts: bounded-concurrency pool + Claude Opus 4.8 via the metered
// client (std-30 getAnthropicClient — never `new Anthropic()`), structured output via
// `messages.parse` + zodOutputFormat, transient-retry, and an injectable client so tests
// run key-free. Portable / codebase-agnostic (std-22): it assumes only a clause body.

import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { and, eq, isNull, ne } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, standardClauses } from "../db/schema.js";
import { getAnthropicClient } from "../agent/anthropic-client.js";
import {
  TESTABILITY_ARCHETYPES,
  type TestabilityVerdict,
} from "./testability.js";

// Claude Opus 4.8 — the model the coding agent itself runs; the classifier is a one-off
// local backfill, so it runs on the most capable tier.
const MODEL = "claude-opus-4-8";

function defaultConcurrency(): number {
  const fromEnv = Number(process.env.CLASSIFY_CONCURRENCY);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? Math.floor(fromEnv) : 16;
}

const MAX_RETRIES = 5;
const RETRY_BASE_MS = 500;

// Structured-output contract. The model emits the full triage shape; only the verdict
// subset (isObligation / testable / archetype) is persisted — `how` and `confidence` are
// triage signals with no production reader (dec-5).
export const TestabilityVerdictSchema = z.object({
  isObligation: z.boolean(),
  testable: z.boolean(),
  archetype: z.enum(TESTABILITY_ARCHETYPES).nullable(),
  how: z.string(),
  confidence: z.number(),
});
export type TestabilityLlmVerdict = z.infer<typeof TestabilityVerdictSchema>;

export interface AnthropicLike {
  messages: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parse: (args: any) => Promise<{ parsed_output: TestabilityLlmVerdict | null }>;
  };
}

export interface ClassifyTestabilityOptions {
  /** Injected client for tests; defaults to the shared metered Anthropic client. */
  client?: AnthropicLike;
  /**
   * Test seam: bypass the model with a deterministic classifier over the clause body.
   * When set, the LLM is never called — used to test orchestration + persistence key-free.
   */
  classify?: (clauseBody: string) => Promise<TestabilityVerdict> | TestabilityVerdict;
  /** Max in-flight clause classifications. Defaults to CLASSIFY_CONCURRENCY env or 16. */
  concurrency?: number;
  /** Progress hook for long runs (called after each clause is classified). */
  onProgress?: (done: number, total: number) => void;
  /**
   * GAP-backfill (dec-6): classify ONLY clauses whose verdict is NULL (never classified).
   * Leaves already-classified clauses untouched.
   */
  gapOnly?: boolean;
  /**
   * Bulk-backfill resilience. When set, a clause that STILL fails after all retries is left
   * UNclassified (no write) and this hook is called; the run continues. When unset, a
   * clause failure throws (the strict single-doc contract).
   */
  onClauseError?: (clauseId: string, err: unknown) => void;
}

class NoStructuredOutputError extends Error {
  constructor() {
    super("testability-classifier: structured output returned no parsed_output");
    this.name = "NoStructuredOutputError";
  }
}

function isTransient(err: unknown): boolean {
  if (err instanceof NoStructuredOutputError) return true;
  const status = (err as { status?: number })?.status;
  if (typeof status === "number") {
    return status === 408 || status === 409 || status === 429 || (status >= 500 && status <= 599);
  }
  const name = (err as { name?: string })?.name ?? "";
  return /connection|timeout|socket|network|fetch/i.test(name);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function withTransientRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= MAX_RETRIES || !isTransient(err)) throw err;
      const backoff = RETRY_BASE_MS * 2 ** attempt;
      const jitter = Math.floor(backoff * 0.25 * Math.random());
      await sleep(backoff + jitter);
    }
  }
}

async function forEachConcurrent<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]!, i);
    }
  };
  const lanes = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: lanes }, () => worker()));
}

function systemPrompt(): string {
  return `You classify ONE clause from a standards document for TESTABILITY — whether an automated, UNIVERSAL test could prove the clause holds everywhere it applies.

Return, for the clause:
- isObligation: true if the clause sets a RULE/obligation (must/never/always/only), false for rationale, scope, vocabulary, examples, or background.
- testable: true ONLY if a single automated test could assert the clause UNIVERSALLY across the whole surface it governs (not a spot check). A clause that is judgment-laden, process-bound, or about humans is not testable.
- archetype: when testable, the strongest applicable kind of universal test; otherwise null. One of:
  - type-constraint: the compiler/type system enforces it everywhere.
  - static-scan: an AST/source sweep proves it.
  - grep-denylist: a regex/string sweep proves the absence of a banned form.
  - schema-introspection: assert over a named table/column/index set.
  - config-parity: an invariant across config/manifest files.
  - registry-completeness: enumerate a set; a forgotten member fails.
  - runtime-property: exercise the running system (strong, but not a static sweep).
- how: one sentence on how the test would work (or why it is not testable).
- confidence: 0..1.

Judge only the clause text. Assume no language, framework, file layout, or tooling.`;
}

/** Classify ONE clause's testability → the persisted verdict subset. */
export async function classifyClauseTestability(
  clauseBody: string,
  opts: ClassifyTestabilityOptions = {},
): Promise<TestabilityVerdict> {
  if (opts.classify) {
    return normalizeVerdict(await opts.classify(clauseBody));
  }
  const client = opts.client ?? (getAnthropicClient() as unknown as AnthropicLike);
  const verdict = await withTransientRetry(async () => {
    const message = await client.messages.parse({
      model: MODEL,
      max_tokens: 1024,
      system: [
        { type: "text", text: systemPrompt(), cache_control: { type: "ephemeral" } },
      ],
      output_config: { format: zodOutputFormat(TestabilityVerdictSchema) },
      messages: [{ role: "user", content: `Clause:\n\n${clauseBody}` }],
    });
    if (!message.parsed_output) throw new NoStructuredOutputError();
    return message.parsed_output;
  });
  return normalizeVerdict(verdict);
}

// Enforce the dependent invariant (a non-testable clause carries no archetype) regardless of
// what the model returned — the same normalization services/testability.ts applies to an
// agent-supplied verdict.
function normalizeVerdict(v: {
  isObligation: boolean;
  testable: boolean;
  archetype: TestabilityVerdict["archetype"];
}): TestabilityVerdict {
  return {
    isObligation: v.isObligation,
    testable: v.testable,
    archetype: v.testable ? v.archetype : null,
  };
}

/** Write the verdict columns directly (deterministic, no bus emit) — the bulk-backfill path. */
async function writeVerdict(clauseId: string, v: TestabilityVerdict): Promise<void> {
  await db
    .update(standardClauses)
    .set({ isObligation: v.isObligation, testable: v.testable, archetype: v.archetype, updatedAt: new Date() })
    .where(eq(standardClauses.id, clauseId));
}

async function classifyAndWrite(
  clauses: { id: string; body: string }[],
  opts: ClassifyTestabilityOptions,
): Promise<void> {
  let done = 0;
  await forEachConcurrent(clauses, opts.concurrency ?? defaultConcurrency(), async (cl) => {
    try {
      const verdict = await classifyClauseTestability(cl.body, opts);
      await writeVerdict(cl.id, verdict);
    } catch (err) {
      if (!opts.onClauseError) throw err;
      opts.onClauseError(cl.id, err);
    }
    done += 1;
    opts.onProgress?.(done, clauses.length);
  });
}

/**
 * Backfill: classify clauses across every standard in a memex (dec-6). The one-off `tsx`
 * script calls this with the real metered client; tests inject `opts.classify`. Idempotent
 * under gapOnly (only NULL-verdict clauses are touched, so a second run classifies nothing
 * new). Returns counts for the operator's log.
 */
export async function backfillTestabilityForMemex(
  memexId: string,
  opts: ClassifyTestabilityOptions = {},
): Promise<{ standards: number; clauses: number }> {
  const standardDocs = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.memexId, memexId), eq(documents.docType, "standard")));

  const all: { id: string; body: string }[] = [];
  for (const doc of standardDocs) {
    const where = opts.gapOnly
      ? and(
          eq(standardClauses.docId, doc.id),
          ne(standardClauses.status, "deleted"),
          isNull(standardClauses.isObligation),
        )
      : and(eq(standardClauses.docId, doc.id), ne(standardClauses.status, "deleted"));
    const cls = await db
      .select({ id: standardClauses.id, body: standardClauses.body })
      .from(standardClauses)
      .where(where);
    all.push(...cls);
  }

  await classifyAndWrite(all, opts);
  return { standards: standardDocs.length, clauses: all.length };
}
