// spec-300 t-3 — reconstruct a byte-faithful, spec-valid SKILL.md string from the
// stored fields [dec-12]. This is the read-path inverse of `parseSkillMd`: given
// the Skill document's title (`name`), `description` column, and section body, it
// re-emits a SKILL.md that the Agent Skills reference validator accepts, so an
// exported Skill drops cleanly into any SKILL.md-aware tool [dec-4, dec-12].
//
// `name` and `description` are authoritative and always lead the frontmatter, in
// canonical order. Any other keys from the optional `frontmatter` passthrough
// (`license`, `metadata`, `allowed-tools`, …) follow, so a parse→reconstruct
// round-trip loses nothing — even though none of those keys drive Memex behaviour
// (`allowed-tools` in particular is ignored entirely) [dec-4].

import yaml from "js-yaml";
import type { ReconstructSkillInput } from "./types.js";

/** Keys that are emitted explicitly and in a fixed position; excluded from the
 *  passthrough sweep so they can never be duplicated or reordered. */
const AUTHORITATIVE_KEYS = new Set(["name", "description"]);

/** Collect passthrough frontmatter keys (everything except name/description),
 *  preserving the caller's key order. */
function passthroughFrontmatter(
  frontmatter: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  if (!frontmatter) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(frontmatter).filter(
      ([key, value]) => !AUTHORITATIVE_KEYS.has(key) && value !== undefined,
    ),
  );
}

/** Reconstruct a byte-faithful SKILL.md string.
 *
 * Shape: `---\n<yaml frontmatter>---\n\n<body>\n`. `parseSkillMd` of the result
 * round-trips back to the same fields. The body is trimmed so repeated
 * reconstruct→parse cycles are stable (idempotent). */
export function reconstructSkillMd(input: ReconstructSkillInput): string {
  const { name, description, body, frontmatter } = input;

  const orderedFrontmatter = {
    name,
    description,
    ...passthroughFrontmatter(frontmatter),
  };

  // lineWidth: -1 disables line folding so long descriptions stay on one line;
  // noRefs avoids YAML anchors/aliases. js-yaml appends a trailing newline.
  const yamlBlock = yaml.dump(orderedFrontmatter, {
    lineWidth: -1,
    noRefs: true,
  });

  const trimmedBody = body.trim();
  const bodyPart = trimmedBody.length > 0 ? `${trimmedBody}\n` : "";

  return `---\n${yamlBlock}---\n\n${bodyPart}`;
}
