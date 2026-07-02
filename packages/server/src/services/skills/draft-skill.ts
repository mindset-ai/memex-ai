// spec-300 t-7 (dec-9, ac-21) — agent-assisted SKILL.md authoring. A non-technical
// author describes a Skill in plain language; this drafts a spec-compliant
// SKILL.md and VALIDATES it (the same validateSkill the upload / in-app / MCP
// write paths run — dec-9) before handing it back for the create flow to persist.
//
// Structured output, not free-text parsing: the model returns its draft through a
// single forced `emit_skill` tool call (name / description / body), so we
// reconstruct a canonical SKILL.md via reconstructSkillMd (t-3) and validate it —
// never scraping a Markdown blob out of prose. The authoring system prompt lives in
// @memex/shared (SKILL_AUTHOR_INSTRUCTION, std-15), never inline here.
//
// LLM access is the sanctioned singleton getAnthropicClient() (std-30); tests inject
// a client double via `opts.client`. This is a DRAFT-and-VALIDATE capability only —
// it persists NOTHING (no mutate() call); the caller/UI persists the returned
// SKILL.md through the existing create flow.

import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient } from "../../agent/anthropic-client.js";
import { SKILL_AUTHOR_INSTRUCTION } from "@memex/shared";
import { ValidationError } from "../../types/errors.js";
import { reconstructSkillMd } from "./reconstruct-skill-md.js";
import { parseSkillMd } from "./parse-skill-md.js";
import { validateSkill } from "./validate-skill.js";
import { SkillValidationError } from "./errors.js";

const MODEL = "claude-sonnet-4-5-20250929";

/** The forced structured-output tool. Its input shape IS the Skill's authoritative
 *  fields (dec-12 / t-3) — name + description + body — from which a canonical
 *  SKILL.md is reconstructed and validated. */
const EMIT_SKILL_TOOL: Anthropic.Tool = {
  name: "emit_skill",
  description:
    "Return the drafted Agent Skill as structured fields. Called exactly once with the final Skill.",
  input_schema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          "Short lowercase hyphen-separated identifier (letters, digits, hyphens; no spaces; <= 64 chars).",
      },
      description: {
        type: "string",
        description:
          "One or two sentences (<= 1024 chars): what the Skill does AND when to use it.",
      },
      body: {
        type: "string",
        description: "The Markdown instructions body — numbered, followable steps.",
      },
    },
    required: ["name", "description", "body"],
  },
};

/** The validated draft the create flow persists. Carries the reconstructed,
 *  skills-ref-valid SKILL.md plus its constituent fields for convenience. */
export interface DraftedSkill {
  readonly skillMd: string;
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

interface EmittedFields {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

/** Pull the fields out of the model's forced `emit_skill` tool call. */
function extractEmittedSkill(message: Anthropic.Message): EmittedFields {
  for (const block of message.content) {
    if (block.type === "tool_use" && block.name === "emit_skill") {
      const input = (block.input ?? {}) as Record<string, unknown>;
      return {
        name: typeof input.name === "string" ? input.name : "",
        description: typeof input.description === "string" ? input.description : "",
        body: typeof input.body === "string" ? input.body : "",
      };
    }
  }
  throw new Error(
    "The authoring model returned no emit_skill tool call; cannot draft a Skill.",
  );
}

/**
 * Draft a spec-compliant SKILL.md from a plain-language description and validate it.
 *
 * Each attempt is a single-turn forced `emit_skill` tool call; on a validation
 * failure we retry ONCE with the error fed back (stateless — a fresh prompt, no
 * tool_use/tool_result bookkeeping). Returns the first draft that passes
 * validateSkill (parse → skills-ref validation, ac-21).
 *
 * @throws {ValidationError} when `description` is blank.
 * @throws {SkillValidationError} when no attempt produces a spec-valid SKILL.md.
 */
export async function draftSkillFromDescription(
  description: string,
  opts: { client?: Anthropic } = {},
): Promise<DraftedSkill> {
  const trimmed = typeof description === "string" ? description.trim() : "";
  if (!trimmed) {
    throw new ValidationError(
      "A plain-language description is required to draft a Skill.",
    );
  }

  const client = opts.client ?? getAnthropicClient();
  const baseUser = `Draft an Agent Skill from this description:\n\n${trimmed}`;

  let lastError: SkillValidationError | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const userContent =
      attempt === 0 || !lastError
        ? baseUser
        : `${baseUser}\n\nYour previous draft failed validation: ${lastError.message}. ` +
          `Fix the ${lastError.field ?? "offending"} field and call emit_skill again.`;

    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: SKILL_AUTHOR_INSTRUCTION,
      tools: [EMIT_SKILL_TOOL],
      tool_choice: { type: "tool", name: "emit_skill" },
      messages: [{ role: "user", content: userContent }],
    });

    const fields = extractEmittedSkill(message);
    const skillMd = reconstructSkillMd({
      name: fields.name,
      description: fields.description,
      body: fields.body,
    });

    try {
      validateSkill(parseSkillMd(skillMd));
      return { skillMd, ...fields };
    } catch (err) {
      if (!(err instanceof SkillValidationError)) throw err;
      lastError = err;
    }
  }

  throw (
    lastError ??
    new SkillValidationError(
      "Could not draft a spec-valid SKILL.md from the description.",
      [],
    )
  );
}
