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
    // spec-469 (dec-2): lead with the OUTCOME ("which parts of your Standards
    // apply"), not the internal noun. Keep an explicit `facets` + `facetBallot`
    // anchor so the copy stays connected to the retained param and tables
    // (dec-1 keeps both) — without it the agent meets an undefined `facetBallot`.
    description:
      "Check which parts of your Standards apply to a piece of work. Lists the topics your Standards are tagged by (security, db-migrations, e2e-testing, and so on). Internally these are your Memex's facets: you cast them as the facetBallot argument on create_task / create_decision, and Memex surfaces the governing standard sections.",
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
        return formatFacetList(vocab);
      }

      throw new ValidationError(`Unknown facets verb '${verb as string}'.`);
    },
  },
];

/**
 * spec-469 (dec-3): format the `list` verb's output. Leads with the outcome and
 * carries an assistant breadcrumb so the agent narrates the ACTION to the user
 * ("which parts of your Standards apply"), never the internal noun. Pure and
 * exported so it is unit-testable without a database.
 */
export function formatFacetList(
  vocab: { key: string; name?: string | null; description: string }[],
): string {
  if (vocab.length === 0) {
    return "No topics defined for this Memex yet (its Standards carry no facet tags).";
  }
  const lines = vocab.map(
    (f) => `- ${f.key}${f.name ? ` (${f.name})` : ""}: ${f.description}`,
  );
  return (
    `Topics your Standards are tagged by (${vocab.length}). Mark the ones a piece of work touches and Memex surfaces the applicable parts of your Standards:\n` +
    lines.join("\n") +
    `\n\n(Note to the assistant: when you tell the user what you're doing here, describe it as checking which parts of their Standards apply to the work, not as "reading facets".)`
  );
}
