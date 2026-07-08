// spec-300 t-10 (dec-20) — Memex-native capability flags authored ON a Skill.
//
// These flags describe what a Skill EXPECTS to touch: the codebase, code editing,
// and external tools. They INFORM downstream routing (which agent surface a Skill
// is offered to) — they are NOT a security boundary and enforce nothing. They are
// distinct from the SKILL.md `allowed-tools` frontmatter, which Memex ignores
// entirely (dec-4). Persisted as a jsonb column on the Skill's `documents` row.

import { z } from "zod";

/** The full, closed capability-flag set. Every field required and boolean so the
 *  stored shape is always complete (no "unknown" tri-state). */
export interface SkillCapabilities {
  readonly codebaseAccess: boolean;
  readonly codeEditing: boolean;
  readonly externalTools: boolean;
}

/** All-false default — a Skill authored without explicit capability flags claims
 *  nothing. Used when `createSkill` is called without `capabilities`. */
export const DEFAULT_SKILL_CAPABILITIES: SkillCapabilities = {
  codebaseAccess: false,
  codeEditing: false,
  externalTools: false,
};

// Each flag defaults to false when omitted, so a partial `{ codeEditing: true }`
// normalises to a complete set. `.strict()` rejects unknown keys so a typo can't
// land silently in the jsonb column.
const capabilitiesSchema = z
  .object({
    codebaseAccess: z.boolean().default(false),
    codeEditing: z.boolean().default(false),
    externalTools: z.boolean().default(false),
  })
  .strict();

/** Validate + normalise a caller-supplied capabilities object into the complete,
 *  closed flag set. `undefined`/`null` → the all-false default.
 *
 * @throws {z.ZodError} when an unknown key or a non-boolean value is supplied. */
export function normalizeCapabilities(
  input: unknown,
): SkillCapabilities {
  if (input === undefined || input === null) {
    return DEFAULT_SKILL_CAPABILITIES;
  }
  return capabilitiesSchema.parse(input);
}
