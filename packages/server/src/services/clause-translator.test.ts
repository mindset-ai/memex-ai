// spec-150 dec-6 — the clause translator (Anthropic Structured Outputs). Key-free: a
// stub client returns a parsed_output, so we verify the contract and failure paths
// without a live model. Structured outputs guarantee the shape, so there is no
// tool-use/retry path to test.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  translateSectionToClauses,
  ClauseTranslationSchema,
  type AnthropicLike,
} from "./clause-translator.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-150/acs/ac-${n}`;

function stubClient(parsedOutput: unknown): AnthropicLike {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messages: { parse: async () => ({ parsed_output: parsedOutput } as any) },
  };
}

describe("spec-150 dec-6: clause translator (Anthropic Structured Outputs)", () => {
  it("returns the ordered clauses from parsed_output (ac-22)", async () => {
    tagAc(AC(22));
    const client = stubClient({
      clauses: [
        "Every surface-touching change extends the smoke suite.",
        "Smoke runs against int after every deploy.",
      ],
    });
    expect(await translateSectionToClauses("anything", { client })).toEqual([
      "Every surface-touching change extends the smoke suite.",
      "Smoke runs against int after every deploy.",
    ]);
  });

  it("passes the full standard as context and still returns the section's clauses (ac-22)", async () => {
    tagAc(AC(22));
    let seenPrompt = "";
    const client: AnthropicLike = {
      messages: {
        parse: async (args) => {
          seenPrompt = String(args.messages[0].content);
          return { parsed_output: { clauses: ["A.", "B."] } } as never;
        },
      },
    };
    const clauses = await translateSectionToClauses("the section", {
      fullDoc: "the whole doc",
      client,
    });
    expect(clauses).toEqual(["A.", "B."]);
    expect(seenPrompt).toContain("the whole doc"); // context included
    expect(seenPrompt).toContain("the section"); // section to split included
  });

  it("requests structured output via output_config.format (ac-22)", async () => {
    tagAc(AC(22));
    let sawFormat = false;
    const client: AnthropicLike = {
      messages: {
        parse: async (args) => {
          sawFormat = Boolean(args.output_config?.format);
          return { parsed_output: { clauses: ["x"] } } as never;
        },
      },
    };
    await translateSectionToClauses("x", { client });
    expect(sawFormat).toBe(true);
  });

  it("throws when structured output is absent or empty (ac-22)", async () => {
    tagAc(AC(22));
    await expect(translateSectionToClauses("x", { client: stubClient(null) })).rejects.toThrow(
      /parsed_output/,
    );
    await expect(
      translateSectionToClauses("x", { client: stubClient({ clauses: [] }) }),
    ).rejects.toThrow(/zero clauses/);
  });

  it("the structured-output schema is an array of strings", () => {
    expect(ClauseTranslationSchema.safeParse({ clauses: ["one aspect"] }).success).toBe(true);
    expect(ClauseTranslationSchema.safeParse({ clauses: "not an array" }).success).toBe(false);
    expect(ClauseTranslationSchema.safeParse({}).success).toBe(false);
  });
});
