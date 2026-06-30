// spec-340 t-6 (dec-9) — the verb-dispatched `facets` MCP tool.
//
// One tool for the whole facet-operations surface, dispatched on a `verb` so the
// low-frequency facet operations never proliferate into separate top-level tools. v0
// implements exactly the `list` verb; the deferred CRUD (add/edit/delete, dec-7) slots
// in here as new verbs, never as new tools.
//
// Read-only (Phase 1 is inert): it reads the vocabulary via services/facet-vocab.ts,
// resolved through the memex's polymorphic owner (dec-7). It does NOT import the LLM
// classifier engine (dec-8).

import { z } from "zod";
import { ValidationError } from "../../types/errors.js";
import { listFacetsForMemex } from "../../services/facet-vocab.js";
import { MEMEX_DESC, VERBOSE_FIELD, type ToolSpec } from "./shared.js";

export const facetsTools: ToolSpec[] = [
  {
    name: "facets",
    annotations: { title: "Facets", readOnlyHint: true, destructiveHint: false },
    description:
      "Read your Memex's FACET vocabulary — the closed, per-owner set of cross-cutting practice areas (security, db-migrations, e2e-testing, api-design, …) that a standard's clauses are tagged with. Verb-dispatched so the whole facet surface stays one tool as it grows; v0 supports the verb 'list'.",
    schema: {
      verb: z
        .enum(["list"])
        .describe("The facet operation. v0: 'list' returns this Memex's facet vocabulary (key, name, description)."),
      memex: z.string().optional().describe(MEMEX_DESC),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const verb = input.verb as "list";
      const memexId = await ctx.resolveMemex(input.memex as string | undefined);

      if (verb === "list") {
        const vocab = await listFacetsForMemex(memexId);
        if (vocab.length === 0) {
          return "No facets defined for this Memex yet.";
        }
        const lines = vocab.map(
          (f) => `- ${f.key}${f.name ? ` (${f.name})` : ""}: ${f.description}`,
        );
        return `Facet vocabulary for this Memex (${vocab.length}):\n${lines.join("\n")}`;
      }

      throw new ValidationError(`Unknown facets verb '${verb as string}'.`);
    },
  },
];
