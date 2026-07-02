// spec-300 t-3 — validate parsed SKILL.md metadata against the Agent Skills
// standard [dec-11]. Runs on every write path (upload, in-app create/edit, MCP
// update_skill); this module is the single validation core they all share.
//
// Validation is delegated to the Agent Skills reference validator
// (`validateMetadata` from `skills-ref`, agentskills.io) so "spec-valid" means
// exactly what the cross-vendor standard means: `name` + `description` required,
// `name` ≤64 chars lowercase-alnum-hyphens, `description` ≤1024 chars. It returns
// a list of human-readable messages (empty = valid). We turn a non-empty list
// into a field-specific SkillValidationError so callers can attach the message
// to the offending input inline [dec-11].
//
// The SKILL.md `allowed-tools` field is intentionally NOT required and drives no
// validation or behaviour — it names Claude-Code-specific tools, is marked
// Experimental, and is non-portable, so Memex ignores it [dec-4].

import { validateMetadata } from "skills-ref";
import { SkillValidationError } from "./errors.js";
import type { ParsedSkill } from "./types.js";

/** Required frontmatter fields, in the order we prefer to surface them. */
const REQUIRED_FIELDS = ["name", "description"] as const;

/** Identify the first required field named by any validation message, so the UI
 *  can highlight it. Falls back to `undefined` when no required field matches
 *  (e.g. a format-only violation on an otherwise-present field). */
function firstNamedField(messages: readonly string[]): string | undefined {
  const haystack = messages.join(" ").toLowerCase();
  return REQUIRED_FIELDS.find((field) => haystack.includes(field));
}

/** Validate the frontmatter of a parsed SKILL.md.
 *
 * @throws {SkillValidationError} when the metadata is not spec-valid — most
 *   importantly when `name` or `description` is missing or blank. The thrown
 *   error names the offending field and carries the full message list. */
export function validateSkill(parsed: Pick<ParsedSkill, "frontmatter">): void {
  // Clone into a plain mutable object: validateMetadata reads it, and we never
  // want to hand a caller's readonly frontmatter to a third-party function.
  const messages = validateMetadata({ ...parsed.frontmatter });
  if (messages.length === 0) {
    return;
  }

  const field = firstNamedField(messages);
  throw new SkillValidationError(
    `Invalid SKILL.md: ${messages.join("; ")}`,
    messages,
    field,
  );
}
