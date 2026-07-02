// spec-300 t-3 — error types for the pure SKILL.md transform layer.
//
// These carry enough structure for callers (upload, in-app editor, MCP
// update_skill) to surface a field-specific, user-visible message [dec-11]
// without re-inspecting free-text.
//
// They extend ValidationError (a DomainError) so BOTH transports classify a bad
// SKILL.md as a client error automatically: the REST error-handler maps
// ValidationError → 400 and the MCP handleError maps it → "Validation error:
// <message>". Before this, they extended bare Error, fell through every mapping,
// and surfaced as an opaque 500 / "Unexpected server error" on every create path
// (spec-300 issue-1) — a user pasting ordinary Markdown with no frontmatter got
// a wall instead of "SKILL.md needs name + description". The subclass identity is
// preserved, so `err instanceof SkillValidationError` (draft-skill's retry loop)
// still works.

import { ValidationError } from "../../types/errors.js";

/** Raised when SKILL.md frontmatter cannot be parsed at all (e.g. no `---` block,
 *  malformed YAML). A malformed Markdown *body* with valid frontmatter is NOT a
 *  parse error — it is accepted as-is and never executed [dec-11]. */
export class SkillParseError extends ValidationError {
  constructor(message: string) {
    super(message, "SKILL_PARSE_ERROR");
    this.name = "SkillParseError";
  }
}

/** Raised when parsed SKILL.md metadata fails validation — most importantly a
 *  missing/blank `name` or `description` [dec-11]. `field` names the first
 *  offending required field when one can be identified, so the UI can attach the
 *  message inline; `errors` carries the full list from the reference validator. */
export class SkillValidationError extends ValidationError {
  readonly errors: readonly string[];
  readonly field?: string;

  constructor(message: string, errors: readonly string[], field?: string) {
    super(message, "SKILL_VALIDATION_ERROR");
    this.name = "SkillValidationError";
    this.errors = errors;
    this.field = field;
  }
}
