// spec-151 dec-7 (t-8) — the adversarial verifier for clause tests.
//
// The spike proved test-AUTHORING (not classification) is the error-prone step:
// first-draft universal tests had a ~25% defect rate, and 5 of 7 reds were test
// bugs, not drift. So a clause test's green/red may NOT be trusted until an
// INDEPENDENT verifier confirms the test genuinely + universally asserts its clause.
//
// The ENGINE (LLM judge) is portable + agent/CI-run, never on a server request path
// (spec-340 dec-8 / std-30 metered client, injectable for tests). The persistence and
// the confirmed-set reader are deterministic. The verifier FAILS CLOSED: anything
// short of an explicit `confirmed` leaves the clause unverified (→ "pending" coverage).

import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { getAnthropicClient } from "../agent/anthropic-client.js";
import { recordClauseTestVerification } from "./clause-verification.js";

const MODEL = "claude-opus-4-8";

export const VerifierVerdictSchema = z.object({
  confirmed: z.boolean(),
  reason: z.string(),
});
export type VerifierVerdict = z.infer<typeof VerifierVerdictSchema>;

export interface AnthropicLike {
  messages: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parse: (args: any) => Promise<{ parsed_output: VerifierVerdict | null }>;
  };
}

export interface ClauseTestToVerify {
  clauseBody: string;
  /** The test's source / excerpt — what the verifier judges against the clause. */
  testSource: string;
}

export interface VerifyOptions {
  client?: AnthropicLike;
  /** Test seam: bypass the model with a deterministic judge (key-free tests). */
  judge?: (args: ClauseTestToVerify) => Promise<VerifierVerdict> | VerifierVerdict;
}

function systemPrompt(): string {
  return `You are an ADVERSARIAL verifier of a single automated test that claims to prove a standards CLAUSE holds.

Confirm ONLY if the test GENUINELY and UNIVERSALLY asserts the clause: it must FAIL when the clause is violated anywhere in the surface the clause governs, and pass only when the clause genuinely holds everywhere.

REJECT (confirmed=false) if the test is tautological (cannot fail / always passes), asserts something OTHER than the clause, is over-broad or under-broad, or only spot-checks when the clause is universal. Default to confirmed=false when uncertain — an unverifiable test must never count.

Judge only the clause text and the test source. Assume no language, framework, or tooling.`;
}

/**
 * Judge whether ONE test genuinely + universally asserts ONE clause. Fails closed:
 * a missing structured output returns confirmed=false (never silently confirms).
 */
export async function verifyClauseTest(
  args: ClauseTestToVerify,
  opts: VerifyOptions = {},
): Promise<VerifierVerdict> {
  if (opts.judge) return opts.judge(args);
  const client = opts.client ?? (getAnthropicClient() as unknown as AnthropicLike);
  const message = await client.messages.parse({
    model: MODEL,
    max_tokens: 1024,
    system: [{ type: "text", text: systemPrompt(), cache_control: { type: "ephemeral" } }],
    output_config: { format: zodOutputFormat(VerifierVerdictSchema) },
    messages: [
      {
        role: "user",
        content: `Clause:\n\n${args.clauseBody}\n\nTest source:\n\n${args.testSource}`,
      },
    ],
  });
  return message.parsed_output ?? { confirmed: false, reason: "verifier returned no structured output" };
}

/**
 * Verify a clause test and persist the verdict in one step — the loop a CI / agent
 * verification pass runs. Returns the verdict so the caller can act on a rejection.
 */
export async function verifyAndRecord(
  input: {
    memexId: string;
    subjectRef: string;
    testIdentifier: string | null;
    clauseBody: string;
    testSource: string;
    verifier?: string;
  },
  opts: VerifyOptions = {},
): Promise<VerifierVerdict> {
  const verdict = await verifyClauseTest(
    { clauseBody: input.clauseBody, testSource: input.testSource },
    opts,
  );
  await recordClauseTestVerification({
    memexId: input.memexId,
    subjectRef: input.subjectRef,
    testIdentifier: input.testIdentifier,
    verdict: verdict.confirmed ? "confirmed" : "rejected",
    verifier: input.verifier ?? MODEL,
    reason: verdict.reason,
  });
  return verdict;
}
