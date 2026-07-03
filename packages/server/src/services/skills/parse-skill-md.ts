// spec-300 t-3 — parse a raw SKILL.md string into its constituent fields [dec-4].
//
// This is the PURE transform between raw SKILL.md text and the fields that back a
// Skill document (title/description/section). It touches no DB and no storage.
//
// Frontmatter parsing is delegated to the Agent Skills reference library
// (`skills-ref`, agentskills.io) so our parse matches the cross-vendor SKILL.md
// standard exactly [dec-4]. `parseFrontmatter` returns the full YAML metadata map
// and the Markdown body; it throws only when the frontmatter block itself is
// absent or malformed — a malformed *body* with valid frontmatter parses fine and
// is accepted as-is (Memex never executes it) [dec-11].

import { parseFrontmatter } from "skills-ref";
import { SkillParseError } from "./errors.js";
import type { ParsedSkill } from "./types.js";

/** Parse a raw SKILL.md string into `{ name, description, body, frontmatter }`.
 *
 * @throws {SkillParseError} when the input is not a string or the YAML
 *   frontmatter block is missing/malformed. */
export function parseSkillMd(raw: string): ParsedSkill {
  if (typeof raw !== "string") {
    throw new SkillParseError("SKILL.md content must be a string.");
  }

  let metadata: Record<string, unknown>;
  let body: string;
  try {
    [metadata, body] = parseFrontmatter(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new SkillParseError(
      `Could not parse SKILL.md frontmatter: ${detail}`,
    );
  }

  return {
    name: typeof metadata.name === "string" ? metadata.name : undefined,
    description:
      typeof metadata.description === "string"
        ? metadata.description
        : undefined,
    body,
    frontmatter: metadata,
  };
}
