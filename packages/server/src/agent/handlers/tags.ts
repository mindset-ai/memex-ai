// spec-418 t-4 — tag-catalogue curation tools (create / rename / delete).
//
// These are THIN wrappers over the SAME services/tags.ts curation functions the
// REST routes (t-3) call (ac-21): createTag / renameTag / deleteTag. The handlers
// resolve the workspace via ctx, parse the tag identity from a `scope::value`/flat
// STRING (parseTagInput — the same convention update_doc's tag strings use), and
// for rename/delete resolve the existing catalogue row CASE-INSENSITIVELY (findTagCI;
// NotFoundError if absent). CI resolution is mandatory here (dec-8): the agent names a
// tag from memory in arbitrary casing, and the 0125 CI unique index guarantees exactly
// one canonical row, so a case-sensitive lookup would 404 a tag that demonstrably
// exists — and contradict TAG_ARG_DESC's "Matching is case-insensitive." promise. (REST
// dodges this by identifying the tag via a tagId path param, not a string.) Attribution
// rides the ToolCtx → RequestCtx bridge (reqCtx), so WHO/HOW
// land on the emitted change events (std-8/std-32) exactly as the REST path's
// restCtx does.
//
// The curation set is EXACTLY {create, rename, delete} — no merge, no bulk/array
// delete (dec-2). A blocked rename throws the service's plain-reason ValidationError
// unchanged, so the MCP surface refuses with the SAME message REST returns (ac-21).
//
// std-16: mirrored in the @memex/shared manifest, held in lockstep by the b-67
// parity regression test.

import { z } from "zod";
import {
  createTag,
  renameTag,
  deleteTag,
  findTagCI,
  formatTag,
  parseTagInput,
} from "../../services/tags.js";
import { NotFoundError } from "../../types/errors.js";
import {
  MEMEX_DESC,
  VERBOSE_FIELD,
  reqCtx,
  type ToolSpec,
} from "./tool-contract.js";

// The tag-identity argument description — one string, shared by all three tools so
// the `scope::value`/flat convention reads identically everywhere. Deliberately
// portable (std-22): no repo paths, no language/framework assumptions.
const TAG_ARG_DESC =
  "The tag as a `scope::value` string (e.g. `priority::high`) — a value within a " +
  "named group — or a flat label with no group (e.g. `bug`). Matching is " +
  "case-insensitive.";

export const tagsTools: ToolSpec[] = [
  {
    name: "create_tag",
    annotations: { title: "Create tag", readOnlyHint: false, destructiveHint: false },
    description:
      "Create a new tag in a workspace's shared tag vocabulary. Give the tag as a `scope::value` " +
      "label (a value within a named group, e.g. `priority::high`) or a flat label (e.g. `bug`). " +
      "Tag names are case-insensitive, so this refuses — naming the existing tag — if one already " +
      "exists rather than silently minting a near-duplicate. This only coins the tag in the catalogue; " +
      "attaching a tag to a Spec is a separate action (update_doc).",
    schema: {
      memex: z.string().optional().describe(MEMEX_DESC),
      tag: z.string().describe(`${TAG_ARG_DESC} This is the tag to create.`),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const memex = input.memex as string | undefined;
      const tagStr = input.tag as string;
      const memexId = await ctx.resolveMemex(memex);
      const { scope, value } = parseTagInput(tagStr);
      const created = await createTag(reqCtx(ctx), memexId, scope, value);
      return `Created tag ${formatTag(created)}.`;
    },
  },
  {
    name: "rename_tag",
    annotations: { title: "Rename tag", readOnlyHint: false, destructiveHint: false },
    description:
      "Rename an existing tag in the catalogue. Identify the current tag by its `scope::value` or flat " +
      "string, and give the new name the same way. The new name is reflected everywhere the tag is used " +
      "— every Spec that carried it — in a single operation. It refuses WITHOUT changing anything when " +
      "the new name would duplicate another tag, or would leave any Spec holding two values of the same " +
      "scope; the refusal states the plain reason.",
    schema: {
      memex: z.string().optional().describe(MEMEX_DESC),
      tag: z.string().describe(`${TAG_ARG_DESC} This is the tag to rename (its current name).`),
      newTag: z
        .string()
        .describe(`${TAG_ARG_DESC} This is the new name to give it.`),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const memex = input.memex as string | undefined;
      const currentStr = input.tag as string;
      const newStr = input.newTag as string;
      const memexId = await ctx.resolveMemex(memex);
      const { scope, value } = parseTagInput(currentStr);
      const existing = await findTagCI(memexId, scope, value);
      if (!existing) {
        throw new NotFoundError(`Tag "${currentStr}" not found in this Memex`);
      }
      const { scope: newScope, value: newValue } = parseTagInput(newStr);
      // renameTag runs the duplicate + per-scope-exclusivity guards and throws the
      // plain-reason ValidationError on a block — propagated unchanged so the MCP
      // refusal matches REST (ac-21). `existing` still holds the pre-rename label.
      const renamed = await renameTag(reqCtx(ctx), memexId, existing.id, newScope, newValue);
      return `Renamed tag ${formatTag(existing)} → ${formatTag(renamed)}.`;
    },
  },
  {
    name: "delete_tag",
    annotations: { title: "Delete tag", readOnlyHint: false, destructiveHint: true },
    description:
      "Delete a tag from the catalogue. Identify it by its `scope::value` or flat string. The tag is " +
      "removed from every Spec that carried it, leaving those Specs otherwise untouched; other tags are " +
      "unaffected. This is irreversible and is never blocked. It deletes exactly one tag — there is no " +
      "bulk form.",
    schema: {
      memex: z.string().optional().describe(MEMEX_DESC),
      tag: z.string().describe(`${TAG_ARG_DESC} This is the tag to delete.`),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const memex = input.memex as string | undefined;
      const tagStr = input.tag as string;
      const memexId = await ctx.resolveMemex(memex);
      const { scope, value } = parseTagInput(tagStr);
      const existing = await findTagCI(memexId, scope, value);
      if (!existing) {
        throw new NotFoundError(`Tag "${tagStr}" not found in this Memex`);
      }
      const result = await deleteTag(reqCtx(ctx), memexId, existing.id);
      const n = result.affectedDocIds.length;
      const from = n > 0 ? ` (removed from ${n} Spec${n === 1 ? "" : "s"})` : "";
      return `Deleted tag ${formatTag(existing)}${from}.`;
    },
  },
];
