// spec-300 t-3 — pure unit tests for the SKILL.md transform layer.
// No database, no storage: parse ↔ validate ↔ reconstruct only.
//
// AC coverage:
//   ac-26 (dec-4)  — SKILL.md adopted verbatim + validate + ignore allowed-tools
//   ac-33 (dec-11) — validation: missing name/description rejected, field named
//   ac-34 (dec-12) — verbatim reconstruction from stored fields
//   ac-2           — create/edit in verbatim SKILL.md format
//   ac-7           — malformed rejected with the missing field named
//   ac-22          — byte-faithful round-trip

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  parseSkillMd,
  validateSkill,
  reconstructSkillMd,
  SkillParseError,
  SkillValidationError,
} from "./index.js";

const AC = {
  verbatim: "mindset-prod/memex-building-itself/specs/spec-300/acs/ac-26",
  validation: "mindset-prod/memex-building-itself/specs/spec-300/acs/ac-33",
  reconstruct: "mindset-prod/memex-building-itself/specs/spec-300/acs/ac-34",
  createEdit: "mindset-prod/memex-building-itself/specs/spec-300/acs/ac-2",
  malformed: "mindset-prod/memex-building-itself/specs/spec-300/acs/ac-7",
  roundTrip: "mindset-prod/memex-building-itself/specs/spec-300/acs/ac-22",
} as const;

const VALID_SKILL_MD = [
  "---",
  "name: pdf-extractor",
  'description: "Extracts text from PDFs. Use when: the user uploads a PDF file."',
  "---",
  "",
  "# PDF extractor",
  "",
  "Steps to extract text from a PDF document.",
  "",
].join("\n");

describe("parseSkillMd", () => {
  it("parses name, description, and body from a valid SKILL.md", () => {
    tagAc(AC.verbatim);
    tagAc(AC.createEdit);

    const parsed = parseSkillMd(VALID_SKILL_MD);

    expect(parsed.name).toBe("pdf-extractor");
    expect(parsed.description).toBe(
      "Extracts text from PDFs. Use when: the user uploads a PDF file.",
    );
    expect(parsed.body).toBe(
      "# PDF extractor\n\nSteps to extract text from a PDF document.",
    );
    // Full frontmatter map is exposed for passthrough.
    expect(parsed.frontmatter.name).toBe("pdf-extractor");
  });

  it("accepts a malformed Markdown body when the frontmatter is valid", () => {
    tagAc(AC.verbatim);

    // Broken/odd Markdown in the body must NOT be a parse error — Memex never
    // executes the body, it stores it as-is [dec-11].
    const raw = [
      "---",
      "name: odd-body",
      "description: A skill with a strange body.",
      "---",
      "",
      "## Unclosed [link](",
      "```",
      "no closing fence",
    ].join("\n");

    const parsed = parseSkillMd(raw);
    expect(parsed.name).toBe("odd-body");
    expect(() => validateSkill(parsed)).not.toThrow();
  });

  it("throws SkillParseError when the frontmatter block is absent", () => {
    tagAc(AC.malformed);

    expect(() => parseSkillMd("# Just markdown, no frontmatter")).toThrow(
      SkillParseError,
    );
  });
});

describe("validateSkill", () => {
  it("passes a well-formed skill", () => {
    tagAc(AC.validation);
    expect(() => validateSkill(parseSkillMd(VALID_SKILL_MD))).not.toThrow();
  });

  it("rejects a missing name with an error naming 'name'", () => {
    tagAc(AC.validation);
    tagAc(AC.malformed);

    const raw = [
      "---",
      "description: Has a description but no name.",
      "---",
      "",
      "body",
    ].join("\n");

    const parsed = parseSkillMd(raw);
    expect(() => validateSkill(parsed)).toThrow(SkillValidationError);
    try {
      validateSkill(parsed);
      throw new Error("expected validateSkill to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SkillValidationError);
      const validationError = error as SkillValidationError;
      expect(validationError.field).toBe("name");
      expect(validationError.message.toLowerCase()).toContain("name");
    }
  });

  it("rejects a missing description with an error naming 'description'", () => {
    tagAc(AC.validation);
    tagAc(AC.malformed);

    const raw = ["---", "name: no-description", "---", "", "body"].join("\n");

    const parsed = parseSkillMd(raw);
    expect(() => validateSkill(parsed)).toThrow(SkillValidationError);
    try {
      validateSkill(parsed);
      throw new Error("expected validateSkill to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SkillValidationError);
      const validationError = error as SkillValidationError;
      expect(validationError.field).toBe("description");
      expect(validationError.message.toLowerCase()).toContain("description");
    }
  });

  it("rejects a blank name with an error naming 'name'", () => {
    tagAc(AC.validation);

    const raw = [
      "---",
      'name: "   "',
      "description: Blank name should fail.",
      "---",
      "",
      "body",
    ].join("\n");

    const parsed = parseSkillMd(raw);
    expect(() => validateSkill(parsed)).toThrow(SkillValidationError);
  });
});

describe("reconstructSkillMd", () => {
  it("emits a spec-valid SKILL.md that parses and validates", () => {
    tagAc(AC.reconstruct);

    const md = reconstructSkillMd({
      name: "pdf-extractor",
      description: "Extracts text from PDFs.",
      body: "# PDF extractor\n\nDoes the thing.",
    });

    expect(md.startsWith("---\n")).toBe(true);
    const parsed = parseSkillMd(md);
    expect(parsed.name).toBe("pdf-extractor");
    expect(parsed.description).toBe("Extracts text from PDFs.");
    expect(parsed.body).toBe("# PDF extractor\n\nDoes the thing.");
    expect(() => validateSkill(parsed)).not.toThrow();
  });

  it("round-trips parse → reconstruct → parse byte-faithfully and stably", () => {
    tagAc(AC.roundTrip);
    tagAc(AC.reconstruct);

    const first = parseSkillMd(VALID_SKILL_MD);
    const rebuilt = reconstructSkillMd({
      name: first.name!,
      description: first.description!,
      body: first.body,
      frontmatter: first.frontmatter,
    });

    // Reconstruct is idempotent: rebuilding from the re-parsed fields yields the
    // exact same bytes.
    const second = parseSkillMd(rebuilt);
    const rebuiltAgain = reconstructSkillMd({
      name: second.name!,
      description: second.description!,
      body: second.body,
      frontmatter: second.frontmatter,
    });

    expect(rebuiltAgain).toBe(rebuilt);
    expect(second.name).toBe(first.name);
    expect(second.description).toBe(first.description);
    expect(second.body).toBe(first.body);
  });

  it("preserves passthrough frontmatter across a round-trip", () => {
    tagAc(AC.roundTrip);

    const rebuilt = reconstructSkillMd({
      name: "with-extras",
      description: "Has extra frontmatter keys.",
      body: "Body text.",
      frontmatter: {
        name: "with-extras",
        description: "Has extra frontmatter keys.",
        license: "MIT",
        metadata: { team: "docs" },
      },
    });

    const parsed = parseSkillMd(rebuilt);
    expect(parsed.frontmatter.license).toBe("MIT");
    expect(parsed.frontmatter.metadata).toEqual({ team: "docs" });
  });
});

describe("allowed-tools frontmatter", () => {
  it("is preserved in parsed frontmatter but is not required and drives no validation", () => {
    tagAc(AC.verbatim);
    tagAc(AC.validation);

    const raw = [
      "---",
      "name: claude-code-skill",
      "description: A skill authored for Claude Code.",
      "allowed-tools: Read, Bash, Edit",
      "---",
      "",
      "# Body",
    ].join("\n");

    const parsed = parseSkillMd(raw);

    // Preserved verbatim under its kebab-case key...
    expect(parsed.frontmatter["allowed-tools"]).toBe("Read, Bash, Edit");
    // ...but never required, and its presence changes no validation outcome.
    expect(() => validateSkill(parsed)).not.toThrow();

    // A skill WITHOUT allowed-tools is equally valid — the field is optional.
    const withoutTools = parseSkillMd(
      ["---", "name: no-tools", "description: No tools declared.", "---", ""].join(
        "\n",
      ),
    );
    expect(withoutTools.frontmatter["allowed-tools"]).toBeUndefined();
    expect(() => validateSkill(withoutTools)).not.toThrow();

    // allowed-tools does NOT survive as a behavioural input: reconstruction from
    // name+description+body alone (no passthrough) omits it entirely.
    const reconstructed = reconstructSkillMd({
      name: parsed.name!,
      description: parsed.description!,
      body: parsed.body,
    });
    expect(reconstructed).not.toContain("allowed-tools");
  });
});
