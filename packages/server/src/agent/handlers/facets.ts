// spec-340 t-13 (dec-9) — the verb-dispatched `facets` MCP tool.
//
// One tool for the whole facet-operations surface, dispatched on a `verb` so the
// low-frequency facet operations never proliferate into separate top-level tools.
// v0 implements exactly the `list` verb; the deferred CRUD (add/edit/delete, dec-7)
// slots in here as new verbs, never as new tools.

import { z } from "zod";
import { ValidationError } from "../../types/errors.js";
import { listOrgFacets } from "../../services/facet-classifier.js";
import { MEMEX_DESC, VERBOSE_FIELD, type ToolSpec } from "./shared.js";

export const facetsTools: ToolSpec[] = [
  {
    name: "facets",
    annotations: { title: "Facets", readOnlyHint: true, destructiveHint: false },
    description:
      "Read your org's FACET vocabulary — the closed set of cross-cutting practice areas (security, db-migrations, e2e-testing, …) that a standard's clauses are tagged with, and that the add_clause tool requires. Verb-dispatched so the whole facet surface stays one tool as it grows; v0 supports the verb 'list'.",
    schema: {
      verb: z
        .enum(["list"])
        .describe("The facet operation. v0: 'list' returns your org's facet vocabulary (key + description)."),
      memex: z.string().optional().describe(MEMEX_DESC),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const verb = input.verb as "list";
      const memexId = await ctx.resolveMemex(input.memex as string | undefined);

      if (verb === "list") {
        const vocab = await listOrgFacets(memexId);
        if (vocab.length === 0) {
          return "No facets defined for this org yet.";
        }
        const lines = vocab.map(
          (f) => `- ${f.key}${f.name ? ` (${f.name})` : ""}: ${f.description}`,
        );
        return (
          `Facet vocabulary for this org (${vocab.length}). Pass the relevant keys to add_clause's ` +
          `required \`facets\` field — or \`[]\` if a clause governs nothing:\n${lines.join("\n")}`
        );
      }

      throw new ValidationError(`Unknown facets verb '${verb as string}'.`);
    },
  },
];
