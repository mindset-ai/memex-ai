// spec-300 t-3 — shared types for the SKILL.md transform layer [dec-4, dec-12].

/** The result of parsing a raw SKILL.md string.
 *
 * `name` → the Skill document's title; `description` → the `documents.description`
 * column; `body` → the doc section body [dec-12]. `frontmatter` is the FULL parsed
 * YAML map, so extra keys (`license`, `metadata`, `allowed-tools`, …) survive a
 * parse→reconstruct round-trip even though Memex behaviour ignores them [dec-4].
 *
 * `name`/`description` are optional here because parsing is deliberately lenient:
 * a SKILL.md missing them still parses, and `validateSkill` is where the required
 * fields are enforced [dec-11]. */
export interface ParsedSkill {
  readonly name?: string;
  readonly description?: string;
  readonly body: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
}

/** The authoritative fields needed to reconstruct a byte-faithful SKILL.md
 *  [dec-12]. `name` + `description` are canonical and lead the frontmatter;
 *  `frontmatter` (optional) carries passthrough keys to preserve, none of which
 *  drive Memex behaviour [dec-4]. */
export interface ReconstructSkillInput {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly frontmatter?: Readonly<Record<string, unknown>>;
}
