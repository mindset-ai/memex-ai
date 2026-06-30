// spec-366 (sol-1): per-domain tool handlers extracted from agent/tool-specs.ts.
// Each module owns one domain's ToolSpec entries (schema + handler);
// agent/tool-specs.ts composes them into the single `toolSpecs` catalogue.
// Infra (ToolCtx, helpers, guidance envelope) lives in ./shared.js (std-12).

import {
  z,
} from "zod";
import {
  buildChildRef,
} from "../../mcp/refs.js";
import {
  addSection,
  updateSection,
  retitleSection,
  deleteSection,
  resolveSectionWriteMode,
} from "../../services/sections.js";
import {
  appendQaReport,
} from "../../services/qa-reports.js";
import {
  addClausesToSection,
  createClause,
  updateClause,
  deleteClause,
} from "../../services/clauses.js";
// spec-423 dec-9 — authoring-time clause classification. Validation lives in the
// NO-LLM facet-vocab.ts and is imported FROM there (never facet-classifier.ts — the
// facet-classifier-no-request-path regression guard).
import { validateClauseFacets, persistClauseFacets } from "../../services/facet-vocab.js";
import {
  ValidationError,
} from "../../types/errors.js";
import {
  VERBOSE_FIELD,
  formatState,
  fullDocState,
  isDocLikeKind,
  reqCtx,
  resolveRefArg,
  type ToolSpec,
} from "./shared.js";

export const sectionsTools: ToolSpec[] = [
  {
    name: "add_section",
    annotations: { title: "Add section", readOnlyHint: false, destructiveHint: false },
    description:
      "Add a new section to a document. The pair (doc, sectionType) is unique within the document — re-using an existing sectionType will fail with a constraint violation. Pick descriptive, unique identifiers on first attempt: 'design', 'architecture', 'testing', 'risks', 'rollout', 'risk-auth', or numbered variants like 'issue-1', 'issue-2'. STANDARDS are authored as clauses: for a standard pass `clauses` (an array of one-aspect clause bodies), NOT `content`; for every other doc type pass `content`. Passing the wrong one for the doc type fails with guidance toward the right field.",
    schema: {
      ref: z
        .string()
        .describe(
          "Canonical ref to the parent document, e.g. `mindset/main/docs/doc-16`.",
        ),
      sectionType: z
        .string()
        .describe("Unique section identifier within the document (e.g. 'design', 'issue-1')."),
      content: z
        .string()
        .optional()
        .describe(
          "Markdown body of the new section. For NON-standard documents. Mutually exclusive with `clauses`.",
        ),
      clauses: z
        .array(z.string())
        .optional()
        .describe(
          "For STANDARDS only: the section's clauses, one self-contained aspect each, in order. A clause is a single granular rule/definition/example — not a compound paragraph. The section's content becomes these clauses joined; each gets an addressable `cl-N` handle returned in the response. Mutually exclusive with `content`.",
        ),
      title: z.string().optional().describe("Optional human-readable section heading. Falls back to sectionType. Do NOT prefix with the section number — the renderer auto-prefixes `${seq}. `. Pass just the heading, e.g. 'Grammar', not '2. Grammar'."),
      description: z.string().optional().describe("Optional free-text metadata describing the section's purpose. Travels with the section everywhere (get_doc/list_docs/section responses) and is editable later via update_section."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const sectionType = input.sectionType as string;
      const content = input.content as string | undefined;
      const clauses = input.clauses as string[] | undefined;
      const title = input.title as string | undefined;
      const description = input.description as string | undefined;

      const resolved = await resolveRefArg(ctx, ref);
      if (!isDocLikeKind(resolved.entity.kind)) {
        throw new ValidationError(
          `add_section expects a doc-level ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs } = resolved;

      // spec-161 doc-type gate: standards take clauses[], everything else takes content.
      const hasContent = typeof content === "string" && content.trim().length > 0;
      const hasClauses =
        Array.isArray(clauses) && clauses.some((c) => typeof c === "string" && c.trim().length > 0);
      const mode = resolveSectionWriteMode({
        isStandard: doc.docType === "standard",
        hasContent,
        hasClauses,
      });

      if (mode === "clauses") {
        // Born clause-first: create the (empty) section, then author its clauses; the
        // service regenerates content = clauses joined.
        const sectionMut = await addSection(memexId, doc.id, sectionType, "", title, description, reqCtx(ctx));
        const clauseMut = await addClausesToSection(memexId, sectionMut.id, clauses!);
        if (ctx.verbose) {
          const state = await fullDocState(memexId, doc.id);
          const url = await ctx.workspaceUrl(memexId);
          return await formatState(url, state, ctx);
        }
        const sectionRef = buildChildRef(slugs, doc, { type: "sections", seq: sectionMut.seq });
        const clauseRefs = clauseMut.map((c) => `cl-${c.seq}`).join(", ");
        return `Added "${sectionMut.title ?? sectionType}" section (ref: ${sectionRef}) with ${clauseMut.length} clause(s): ${clauseRefs}.`;
      }

      const section = await addSection(memexId, doc.id, sectionType, content!, title, description, reqCtx(ctx));
      if (ctx.verbose) {
        const state = await fullDocState(memexId, doc.id);
        const url = await ctx.workspaceUrl(memexId);
        return await formatState(url, state, ctx);
      }
      const sectionRef = buildChildRef(slugs, doc, { type: "sections", seq: section.seq });
      return `Added "${section.title ?? section.sectionType}" section (ref: ${sectionRef}).`;
    },
  },
  {
    name: "write_qa_report",
    annotations: { title: "Write QA report", readOnlyHint: false, destructiveHint: false },
    description:
      "Persist a QA Report on a Spec at the build→verify hand-off — a human-readable record of what THIS build session actually changed, written for a reviewer who was not in the session (including a non-developer owner). Organise it so each audience finds its part: (1) Front-end / user-affecting changes in plain language, (2) Back-end changes (routes, schema/migrations, services, auth/tenancy, agent behaviour), (3) Testing created and run (which tests, which suites, what passed, what was skipped or left red — tie back to the Spec's ACs), (4) Known gaps & follow-ups (also captured via register_issue todos), (5) Deviations from the plan, (6) Dependencies & integration points, (7) Migration/deployment notes, (8) Open questions. Ground every claim in the changes you made this session and the tests you ran — never restate the plan. Each call APPENDS a new dated version (qa_report, qa_report-2, …); it never overwrites a prior session's report. Read-only once written.",
    schema: {
      ref: z
        .string()
        .describe("Canonical ref to the Spec the report is for, e.g. `mindset/main/specs/spec-3`."),
      content: z
        .string()
        .describe(
          "Markdown body of the report, structured into the front-end / back-end / testing / gaps / deviations / dependencies / deploy-notes / open-questions sections described above. Grounded in this session's actual changes — not a restatement of the plan.",
        ),
      title: z
        .string()
        .optional()
        .describe("Optional heading for the report row. Defaults to 'QA Report'."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const content = input.content as string;
      const title = input.title as string | undefined;

      const resolved = await resolveRefArg(ctx, ref);
      if (!isDocLikeKind(resolved.entity.kind)) {
        throw new ValidationError(
          `write_qa_report expects a Spec ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs } = resolved;
      if (doc.docType !== "spec") {
        throw new ValidationError(
          "QA Reports attach to Specs only — pass a `spec-N` ref.",
        );
      }

      const section = await appendQaReport(memexId, doc.id, content, title, reqCtx(ctx));
      if (ctx.verbose) {
        const state = await fullDocState(memexId, doc.id);
        const url = await ctx.workspaceUrl(memexId);
        return await formatState(url, state, ctx);
      }
      const sectionRef = buildChildRef(slugs, doc, { type: "sections", seq: section.seq });
      return `Wrote QA Report "${section.sectionType}" (ref: ${sectionRef}) for ${doc.handle}. Each build session appends a new version — prior reports are preserved.`;
    },
  },
  {
    name: "update_section",
    annotations: { title: "Update section", readOnlyHint: false, destructiveHint: false },
    description: "Update the content of a document section, and optionally its writable metadata (`sectionType` machine key and free-text `description`). Returns the full document state. A `sectionType` collision with another section on the same document fails with a readable error (pick a different identifier).",
    schema: {
      ref: z
        .string()
        .describe(
          "Canonical ref to the section, e.g. `mindset/main/docs/doc-16/sections/s-3`.",
        ),
      content: z.string().describe("New markdown body, replacing the existing content."),
      sectionType: z
        .string()
        .optional()
        .describe("Optional new machine key for the section. Omit to keep the existing key. Must be unique within the document."),
      description: z
        .string()
        .optional()
        .describe("Optional free-text metadata describing the section's purpose. Omit to leave it unchanged."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const content = input.content as string;
      const sectionType = input.sectionType as string | undefined;
      const description = input.description as string | undefined;

      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "section") {
        throw new ValidationError(
          `update_section expects a section ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs, entity } = resolved;
      // spec-161: standards are edited at the clause grain, not as prose blobs.
      if (doc.docType === "standard") {
        throw new ValidationError(
          "Standards are edited at the clause grain. Use add_clause / edit_clause / delete_clause, not update_section.",
        );
      }
      const section = await updateSection(memexId, entity.row.id, content, { sectionType, description }, reqCtx(ctx));
      if (ctx.verbose) {
        const state = await fullDocState(memexId, section.docId);
        const url = await ctx.workspaceUrl(memexId);
        return await formatState(url, state, ctx);
      }
      const sectionRef = buildChildRef(slugs, doc, { type: "sections", seq: section.seq });
      return `Section updated (ref: ${sectionRef}).`;
    },
  },
  // ── Clause CRUD (standards only) ──────────────────────────
  {
    name: "add_clause",
    annotations: { title: "Add clause", readOnlyHint: false, destructiveHint: false },
    description:
      "Append a clause to a STANDARD section (or insert at a position). A clause is one self-contained aspect — a single rule, definition, or example, not a compound paragraph. Standards only: for other doc types edit the section body with update_section. The new clause gets an allocate-once cl-N handle, returned in the response.",
    schema: {
      ref: z
        .string()
        .describe(
          "Canonical ref to the standard SECTION the clause belongs to, e.g. `mindset/main/standards/std-7/sections/s-2`.",
        ),
      body: z.string().describe("The clause body — one self-contained aspect, markdown."),
      position: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("1-based display position to insert at; omit to append at the end."),
      // spec-423 dec-9 — REQUIRED facet verdict (where the Memex has a vocabulary): an
      // array of facet keys this clause governs, or [] for "governs nothing" (a
      // definition / example / rationale clause). An absent or unknown-key verdict is
      // rejected with the vocabulary re-handed.
      facets: z
        .array(z.string())
        .optional()
        .describe(
          "The facet keys this clause governs (dec-9). Required: an array of keys, or [] for \"governs nothing\". Unknown keys are rejected; call the `facets` tool (verb 'list') to read the vocabulary.",
        ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const body = input.body as string;
      const position = input.position as number | undefined;

      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "section") {
        throw new ValidationError(
          `add_clause expects a standard section ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs, entity } = resolved;
      if (doc.docType !== "standard") {
        throw new ValidationError(
          "Only standards have clauses. Use update_section to edit this document's section body.",
        );
      }
      // Validate the facet verdict BEFORE creating the clause, so a rejected verdict
      // (re-handing the vocabulary) leaves no orphan clause (dec-9). Returns null when
      // the Memex has no vocabulary (no verdict required).
      const facetIds = await validateClauseFacets(memexId, input.facets as string[] | undefined);
      const clause = await createClause(memexId, entity.row.id, body, position);
      if (facetIds !== null) {
        await persistClauseFacets(memexId, doc.id, clause.id, facetIds, reqCtx(ctx));
      }
      if (ctx.verbose) {
        const state = await fullDocState(memexId, doc.id);
        const url = await ctx.workspaceUrl(memexId);
        return await formatState(url, state, ctx);
      }
      const clauseRef = buildChildRef(slugs, doc, { type: "clauses", seq: clause.seq });
      return `Added clause cl-${clause.seq} (ref: ${clauseRef}).`;
    },
  },
  {
    name: "edit_clause",
    annotations: { title: "Edit clause", readOnlyHint: false, destructiveHint: false },
    description:
      "Edit a STANDARD clause's body by its cl-N ref. Standards only. The section's content (the join of its clauses) is regenerated; the clause keeps its cl-N identity.",
    schema: {
      ref: z
        .string()
        .describe(
          "Canonical ref to the clause, e.g. `mindset/main/standards/std-7/clauses/cl-12`.",
        ),
      body: z.string().describe("New clause body — one self-contained aspect, markdown."),
      // spec-423 dec-9 — OPTIONAL facet verdict on edit. Omit to leave tags unchanged;
      // provide an array of keys (or [] for "governs nothing") to replace them.
      facets: z
        .array(z.string())
        .optional()
        .describe(
          "Optional facet re-classification (dec-9). Omit = tags unchanged; provide an array of keys (or [] for \"governs nothing\") to replace them.",
        ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const body = input.body as string;

      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "clause") {
        throw new ValidationError(
          `edit_clause expects a clause ref (cl-N); got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs, entity } = resolved;
      const clause = await updateClause(memexId, entity.row.id, body);
      // Re-classify only when a verdict is supplied (omit = unchanged, dec-9).
      if (input.facets !== undefined) {
        const facetIds = await validateClauseFacets(memexId, input.facets as string[]);
        if (facetIds !== null) {
          await persistClauseFacets(memexId, doc.id, entity.row.id, facetIds, reqCtx(ctx));
        }
      }
      if (ctx.verbose) {
        const state = await fullDocState(memexId, doc.id);
        const url = await ctx.workspaceUrl(memexId);
        return await formatState(url, state, ctx);
      }
      const clauseRef = buildChildRef(slugs, doc, { type: "clauses", seq: clause.seq });
      return `Clause cl-${clause.seq} updated (ref: ${clauseRef}).`;
    },
  },
  {
    name: "delete_clause",
    annotations: { title: "Delete clause", readOnlyHint: false, destructiveHint: false },
    description:
      "Soft-delete a STANDARD clause by its cl-N ref. The cl-N is frozen (never reused) and siblings are NOT resequenced; the section content is regenerated without it. Standards only.",
    schema: {
      ref: z
        .string()
        .describe(
          "Canonical ref to the clause, e.g. `mindset/main/standards/std-7/clauses/cl-12`.",
        ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;

      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "clause") {
        throw new ValidationError(
          `delete_clause expects a clause ref (cl-N); got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, entity } = resolved;
      const clause = await deleteClause(memexId, entity.row.id);
      if (ctx.verbose) {
        const state = await fullDocState(memexId, doc.id);
        const url = await ctx.workspaceUrl(memexId);
        return await formatState(url, state, ctx);
      }
      return `Clause cl-${clause.seq} deleted.`;
    },
  },
  {
    name: "retitle_section",
    annotations: { title: "Retitle section", readOnlyHint: false, destructiveHint: false },
    description:
      "Change a section's heading (and, optionally, its machine key). Sets `title` to the new heading; pass `sectionType` to also rekey the section's identifier. Content is left untouched — use `update_section` for body edits. A `sectionType` collision with another section on the same document fails with a readable error (pick a different identifier). Do NOT prefix the title with the section number — the renderer auto-prefixes `${seq}. `.",
    schema: {
      ref: z
        .string()
        .describe(
          "Canonical ref to the section, e.g. `mindset/main/specs/spec-3/sections/s-3`.",
        ),
      title: z.string().describe("New human-readable heading. Pass just the heading, e.g. 'Considerations', not '3. Considerations'."),
      sectionType: z
        .string()
        .optional()
        .describe("Optional new machine key. Omit to keep the existing key and change only the heading. Must be unique within the document."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const title = input.title as string;
      const sectionType = input.sectionType as string | undefined;

      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "section") {
        throw new ValidationError(
          `retitle_section expects a section ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs, entity } = resolved;
      const section = await retitleSection(memexId, entity.row.id, title, sectionType);
      if (ctx.verbose) {
        const state = await fullDocState(memexId, section.docId);
        const url = await ctx.workspaceUrl(memexId);
        return await formatState(url, state, ctx);
      }
      const sectionRef = buildChildRef(slugs, doc, { type: "sections", seq: section.seq });
      return `Section retitled to "${section.title}" (ref: ${sectionRef}).`;
    },
  },
  {
    name: "delete_section",
    // Soft-delete (→ status=deleted), reversible — so NOT destructive in the
    // irreversible sense, matching delete_decision's annotation.
    annotations: { title: "Delete section", readOnlyHint: false, destructiveHint: false },
    description:
      "Soft-delete a section: transitions it to status `deleted`. Deleted sections are hidden from `get_doc`, list/render paths, and search, but remain restorable to their prior status. The remaining sections resequence so their numbers stay contiguous (no gap). Anchored comments stay attached to the deleted section (they reappear on restore); any `tasks.section_ref` pointing at it dangles harmlessly as free text. Use this to clean up a stale or superseded section during a recut.",
    schema: {
      ref: z
        .string()
        .describe(
          "Canonical ref to the section to delete, e.g. `mindset/main/specs/spec-3/sections/s-4`.",
        ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "section") {
        throw new ValidationError(
          `delete_section expects a section ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs, entity } = resolved;
      const section = await deleteSection(memexId, entity.row.id);
      if (ctx.verbose) {
        const state = await fullDocState(memexId, section.docId);
        const url = await ctx.workspaceUrl(memexId);
        return await formatState(url, state, ctx);
      }
      const sectionRef = buildChildRef(slugs, doc, { type: "sections", seq: section.seq });
      return `Section deleted (ref: ${sectionRef}) "${section.title ?? section.sectionType}". Remaining sections resequenced.`;
    },
  },

  // ── Decision CRUD + named verbs ───────────────────────────
];
