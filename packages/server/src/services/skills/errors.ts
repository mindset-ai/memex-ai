// spec-300 t-3 — error types for the pure SKILL.md transform layer.
//
// These carry enough structure for callers (upload, in-app editor, MCP
// update_skill) to surface a field-specific, user-visible message [dec-11]
// without re-inspecting free-text. They are transport-agnostic: the HTTP/MCP
// layers map them to their own status codes.

/** Raised when SKILL.md frontmatter cannot be parsed at all (e.g. no `---` block,
 *  malformed YAML). A malformed Markdown *body* with valid frontmatter is NOT a
 *  parse error — it is accepted as-is and never executed [dec-11]. */
export class SkillParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillParseError";
  }
}

/** Raised when parsed SKILL.md metadata fails validation — most importantly a
 *  missing/blank `name` or `description` [dec-11]. `field` names the first
 *  offending required field when one can be identified, so the UI can attach the
 *  message inline; `errors` carries the full list from the reference validator. */
export class SkillValidationError extends Error {
  readonly errors: readonly string[];
  readonly field?: string;

  constructor(message: string, errors: readonly string[], field?: string) {
    super(message);
    this.name = "SkillValidationError";
    this.errors = errors;
    this.field = field;
  }
}
