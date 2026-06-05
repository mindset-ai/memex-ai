// spec-136 t-2 — tag service: create-or-pick + set-tags with per-scope mutual
// exclusivity. The bridge table is scope-blind (db/schema.ts); the "one value per
// scope on a Spec" rule lives here in the write path (dec-1).
//
// Vocabulary: a tag is structured {scope, value} (dec-1). The `scope::value` string
// convention maps onto that shape at this boundary (parseTagInput). A flat tag has
// scope = null and is multi-valued; a scoped tag is mutually exclusive within its
// scope on a given Spec.
//
// All writes go through mutate() per std-8. Tag-catalogue creates emit `tag` created;
// changes to a tag *on a Spec* emit `document` updated so the Spec's card refreshes.
//
// Attribution (develop's spec-122 actor/channel contract): WHO acted is carried on
// the bus ChangeEvent's `channel` (rest_ui→human, mcp→mcp_agent, server→system) →
// activity_log (services/activity-log.ts). So every mutate() call here MUST receive a
// RequestCtx with the originating channel — REST passes {channel:'rest_ui'}, MCP passes
// {channel:'mcp', userId}. The denormalised bridge column mirrors doc_assignees: a
// single `added_by` FK to users (db/schema.ts) — passed here as `addedBy` (string|null),
// NOT the author_name/author_namespace_id stub the pre-develop reference carried.

import { and, eq, isNull, inArray, ne } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, tags, documentTags } from "../db/schema.js";
import type { Tag, DocumentTag } from "../db/schema.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import { mutate, forwardBrand, type Mutated, type RequestCtx } from "./mutate.js";

const SCOPE_SEPARATOR = "::";

export interface ParsedTag {
  scope: string | null;
  value: string;
}

/**
 * Parse a `scope::value` string into the structured {scope, value} shape.
 * - `priority::high` → { scope: "priority", value: "high" } (scoped)
 * - `bug`            → { scope: null, value: "bug" }        (flat)
 * - `::high` / ` ::high` → flat (empty scope is treated as no scope)
 * Only the FIRST `::` separates scope from value, so `a::b::c` → { "a", "b::c" }.
 * Throws ValidationError on an empty tag or an empty value.
 */
export function parseTagInput(raw: string): ParsedTag {
  const trimmed = raw.trim();
  if (!trimmed) throw new ValidationError("Tag cannot be empty");

  const idx = trimmed.indexOf(SCOPE_SEPARATOR);
  if (idx === -1) return { scope: null, value: trimmed };

  const scope = trimmed.slice(0, idx).trim();
  const value = trimmed.slice(idx + SCOPE_SEPARATOR.length).trim();
  if (!value) throw new ValidationError(`Tag "${raw}" has an empty value`);
  return { scope: scope || null, value };
}

/** Render a structured tag back to its `scope::value` (or flat) string form. */
export function formatTag(tag: Pick<Tag, "scope" | "value">): string {
  return tag.scope === null ? tag.value : `${tag.scope}${SCOPE_SEPARATOR}${tag.value}`;
}

/**
 * Find an existing tag by its canonical (memexId, scope, value), or create it.
 * Idempotent: unique(memex_id, scope, value) with NULLS NOT DISTINCT guarantees one
 * row per canonical tag, so the same `priority::high` always resolves to one row and
 * `bug` (scope = null) never duplicates.
 */
export async function getOrCreateTag(
  ctx: RequestCtx,
  memexId: string,
  scope: string | null,
  value: string,
): Promise<Tag> {
  const scopePred = scope === null ? isNull(tags.scope) : eq(tags.scope, scope);
  const matchTag = and(eq(tags.memexId, memexId), scopePred, eq(tags.value, value));

  const [existing] = await db.select().from(tags).where(matchTag).limit(1);
  if (existing) return existing;

  const created = await mutate(
    ctx,
    { memexId, entity: "tag", action: "created" },
    async () => {
      // onConflictDoNothing covers the race where a concurrent caller inserted the
      // same canonical tag between our SELECT and INSERT.
      const [row] = await db
        .insert(tags)
        .values({ memexId, scope, value })
        .onConflictDoNothing()
        .returning();
      return row ?? null;
    },
  );
  if (created) return created;

  // Lost the create race — the row exists now; read it back.
  const [row] = await db.select().from(tags).where(matchTag).limit(1);
  if (!row) throw new Error("getOrCreateTag: tag missing after conflict");
  return row;
}

/**
 * Lookup-only sibling of getOrCreateTag: resolve an existing tag by its canonical
 * (memexId, scope, value), or return null. Used by the remove path (t-4) — removing
 * a tag that was never coined must not mint a catalogue row as a side effect.
 */
export async function findTag(
  memexId: string,
  scope: string | null,
  value: string,
): Promise<Tag | null> {
  const scopePred = scope === null ? isNull(tags.scope) : eq(tags.scope, scope);
  const [existing] = await db
    .select()
    .from(tags)
    .where(and(eq(tags.memexId, memexId), scopePred, eq(tags.value, value)))
    .limit(1);
  return existing ?? null;
}

/**
 * Attach a tag to a Spec. If the tag is scoped (non-null scope), first remove any
 * OTHER tag in that scope from this Spec — the write-path enforcement of mutual
 * exclusivity (dec-1). Flat tags are never displaced. Idempotent on (document_id,
 * tag_id): re-applying the same tag is a no-op that returns null.
 *
 * `addedBy` is the user the link is attributed to (doc_assignees.assigned_by parallel);
 * it is stored on the row (ON DELETE SET NULL). Actor *kind* travels on the bus event's
 * channel (ctx.channel) → activity_log, not here.
 */
export async function setTagOnDoc(
  ctx: RequestCtx,
  memexId: string,
  docId: string,
  tag: Tag,
  addedBy?: string | null,
): Promise<Mutated<DocumentTag | null>> {
  return mutate(
    ctx,
    { memexId, docId, entity: "document", action: "updated" },
    async () => {
      if (tag.scope !== null) {
        // One value per scope on a given Spec: drop other tags sharing this scope.
        const sameScopeTagIds = db
          .select({ id: tags.id })
          .from(tags)
          .where(and(eq(tags.memexId, memexId), eq(tags.scope, tag.scope)));
        await db
          .delete(documentTags)
          .where(
            and(
              // Explicit tenant predicate for consistency with removeTagFromDoc and
              // the "memex_id on every tag write" invariant. The sameScopeTagIds
              // subquery already scopes by memexId, so this is belt-and-suspenders.
              eq(documentTags.memexId, memexId),
              eq(documentTags.docId, docId),
              inArray(documentTags.tagId, sameScopeTagIds),
              ne(documentTags.tagId, tag.id),
            ),
          );
      }

      const [row] = await db
        .insert(documentTags)
        .values({
          memexId,
          docId,
          tagId: tag.id,
          addedBy: addedBy ?? null,
        })
        .onConflictDoNothing()
        .returning();
      return row ?? null;
    },
  );
}

/** Remove a single tag link from a Spec. Returns how many links were removed (0 or 1).
 *  The DELETE is tenant-scoped by `memexId` (spec-125): docId/tagId arrive from the
 *  request, so without this predicate a caller in memex A could delete a link in
 *  memex B by passing a foreign (docId, tagId) — a cross-tenant write. The memexId
 *  clause makes a foreign link simply not match (no-op), upholding the same-tenant
 *  invariant in the write path for every caller, not just the guarded routes. */
export async function removeTagFromDoc(
  ctx: RequestCtx,
  memexId: string,
  docId: string,
  tagId: string,
): Promise<Mutated<{ removed: number }>> {
  return mutate(
    ctx,
    { memexId, docId, entity: "document", action: "updated" },
    async () => {
      const deleted = await db
        .delete(documentTags)
        .where(
          and(
            eq(documentTags.memexId, memexId),
            eq(documentTags.docId, docId),
            eq(documentTags.tagId, tagId),
          ),
        )
        .returning();
      return { removed: deleted.length };
    },
  );
}

/**
 * The whole tag catalogue for a Memex, ordered scope-then-value. Feeds the
 * REST `/tags` type-ahead (t-4): the picker offers every `scope::value` already
 * coined in this Memex so users converge on a shared vocabulary instead of
 * minting near-duplicates. Catalogue-wide (every row in `tags` for the Memex),
 * independent of which Specs currently carry them.
 */
export async function listMemexTags(memexId: string): Promise<Tag[]> {
  return db
    .select()
    .from(tags)
    .where(eq(tags.memexId, memexId))
    .orderBy(tags.scope, tags.value);
}

/** The tags currently on a Spec, ordered scope-then-value for stable rendering. */
export async function listDocTags(memexId: string, docId: string): Promise<Tag[]> {
  return db
    .select({
      id: tags.id,
      memexId: tags.memexId,
      scope: tags.scope,
      value: tags.value,
      createdAt: tags.createdAt,
    })
    .from(documentTags)
    .innerJoin(tags, eq(tags.id, documentTags.tagId))
    .where(and(eq(documentTags.memexId, memexId), eq(documentTags.docId, docId)))
    .orderBy(tags.scope, tags.value);
}

/**
 * Batch sibling of listDocTags (t-4): the tags on each of many Specs in ONE
 * round-trip, keyed by docId. Feeds the REST list endpoint so the Specs board
 * can render every card's tags without an N+1 fan-out — mirrors the single-query
 * attach pattern used by listDocs's includeAssignees. Docs with no tags are
 * absent from the map (callers default to []). Ordered scope-then-value within
 * each doc for stable rendering.
 */
export async function listDocTagsForDocs(
  memexId: string,
  docIds: string[],
): Promise<Map<string, Tag[]>> {
  const byDoc = new Map<string, Tag[]>();
  if (docIds.length === 0) return byDoc;

  const rows = await db
    .select({
      docId: documentTags.docId,
      id: tags.id,
      memexId: tags.memexId,
      scope: tags.scope,
      value: tags.value,
      createdAt: tags.createdAt,
    })
    .from(documentTags)
    .innerJoin(tags, eq(tags.id, documentTags.tagId))
    .where(and(eq(documentTags.memexId, memexId), inArray(documentTags.docId, docIds)))
    .orderBy(tags.scope, tags.value);

  for (const { docId, ...tag } of rows) {
    const list = byDoc.get(docId) ?? [];
    list.push(tag);
    byDoc.set(docId, list);
  }
  return byDoc;
}

/**
 * High-level entry point used by the MCP doc-update path (t-4): apply a
 * `scope::value`/flat tag string to a Spec, creating the tag if it's new and
 * honouring per-scope mutual exclusivity. Validates the Spec belongs to the Memex
 * (the same-tenant invariant) before writing.
 */
export async function applyTagString(
  ctx: RequestCtx,
  memexId: string,
  docId: string,
  raw: string,
  addedBy?: string | null,
): Promise<Mutated<Tag>> {
  await assertDocInMemex(memexId, docId);
  const { scope, value } = parseTagInput(raw);
  const tag = await getOrCreateTag(ctx, memexId, scope, value);
  // setTagOnDoc is the observable write (emits `document` updated) and returns the
  // Mutated brand. Forward that brand onto the resolved tag so the compile-time
  // guarantee survives this orchestrator boundary (spec-156 ac-20) — no second emit.
  const link = await setTagOnDoc(ctx, memexId, docId, tag, addedBy);
  return forwardBrand(link, tag);
}

/**
 * Batch form of applyTagString (t-4 cleanup): validate the Spec belongs to the
 * Memex ONCE, then apply each `scope::value`/flat string in order (create-or-pick +
 * per-scope mutual exclusivity), returning the resolved tags. This is the entry point
 * the REST set route uses, so a picker sending N tags pays one tenant check rather
 * than N. NOTE: not a single transaction — each apply still emits its own change event
 * and a mid-batch invalid entry leaves earlier applies committed; adequate for the
 * small N a picker sends, and documented so larger callers know the semantics.
 */
export async function applyTagStrings(
  ctx: RequestCtx,
  memexId: string,
  docId: string,
  raws: string[],
  addedBy?: string | null,
): Promise<Tag[]> {
  await assertDocInMemex(memexId, docId);
  const applied: Tag[] = [];
  for (const raw of raws) {
    const { scope, value } = parseTagInput(raw);
    const tag = await getOrCreateTag(ctx, memexId, scope, value);
    await setTagOnDoc(ctx, memexId, docId, tag, addedBy);
    applied.push(tag);
  }
  return applied;
}

/**
 * High-level remove counterpart to applyTagString (t-4): take a `scope::value`/flat
 * string, resolve it to an existing catalogue tag, and drop its link from the Spec.
 * Returns the resolved tag when a link was actually removed, or null when the tag
 * doesn't exist in this Memex or wasn't on the Spec (idempotent no-op). Never creates
 * a catalogue row — a remove of an unknown tag is silently a no-op.
 */
export async function removeTagString(
  ctx: RequestCtx,
  memexId: string,
  docId: string,
  raw: string,
): Promise<Mutated<Tag> | null> {
  await assertDocInMemex(memexId, docId);
  const { scope, value } = parseTagInput(raw);
  const tag = await findTag(memexId, scope, value);
  if (!tag) return null;
  // removeTagFromDoc is the observable write (emits `document` updated) and returns
  // the Mutated brand. Forward that brand onto the resolved tag so the compile-time
  // guarantee survives this orchestrator boundary (spec-156 ac-20). When nothing was
  // actually linked we return a plain null — a true no-op with no write to brand.
  const result = await removeTagFromDoc(ctx, memexId, docId, tag.id);
  return result.removed > 0 ? forwardBrand(result, tag) : null;
}

/** Guard the same-tenant invariant: the Spec must exist in this Memex. */
async function assertDocInMemex(memexId: string, docId: string): Promise<void> {
  const [doc] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.id, docId), eq(documents.memexId, memexId)))
    .limit(1);
  if (!doc) throw new NotFoundError(`Document ${docId} not found in this Memex`);
}
