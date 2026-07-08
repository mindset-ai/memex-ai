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

import { and, eq, isNull, inArray, ne, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, tags, documentTags } from "../db/schema.js";
import type { Tag, DocumentTag } from "../db/schema.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import { mutate, forwardBrand, type Mutated, type RequestCtx } from "./mutate.js";
import type { ChangeKey } from "./mutate.js";

const SCOPE_SEPARATOR = "::";

// spec-418 t-2 (ac-37): the boundary bound on a tag scope/value. An impl detail, not
// a fork surface — chosen to comfortably hold any real `scope::value` while rejecting
// the pathological (a pasted paragraph, a mangled control-char blob). Both parts share
// the bound because they're the same kind of short human label.
const MAX_TAG_PART_LENGTH = 128;

// C0 controls (U+0000–U+001F) + DEL (U+007F). A tag is a short human label; a control
// char in it is always corruption (accidental paste, mangled encoding), never intent.
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

export interface ParsedTag {
  scope: string | null;
  value: string;
}

/**
 * Validate + normalise a structured {scope, value} at the curation write boundary
 * (createTag / renameTag), BEFORE any DB access (spec-418 ac-37). The sibling of
 * parseTagInput (which parses the `scope::value` STRING form); this one operates on
 * the already-split parts the admin surfaces send. Rules:
 *   - trim both parts; an empty-after-trim SCOPE collapses to null (a flat tag),
 *     mirroring parseTagInput's "empty scope ⇒ flat" rule;
 *   - an empty-after-trim VALUE is invalid (a tag must name something);
 *   - either part longer than MAX_TAG_PART_LENGTH is invalid;
 *   - a control char in either part is invalid.
 * Throws ValidationError (a plain human message) on any breach; returns the cleaned
 * {scope, value} otherwise. Callers use the returned values — never the raw inputs.
 */
export function validateTagInput(
  scope: string | null,
  value: string,
): { scope: string | null; value: string } {
  const trimmedValue = value.trim();
  if (!trimmedValue) throw new ValidationError("Tag value cannot be empty");
  if (trimmedValue.length > MAX_TAG_PART_LENGTH) {
    throw new ValidationError(
      `Tag value must be at most ${MAX_TAG_PART_LENGTH} characters`,
    );
  }
  if (CONTROL_CHARS.test(trimmedValue)) {
    throw new ValidationError("Tag value must not contain control characters");
  }

  const trimmedScope = scope === null ? null : scope.trim();
  const normScope = trimmedScope ? trimmedScope : null;
  if (normScope !== null) {
    if (normScope.length > MAX_TAG_PART_LENGTH) {
      throw new ValidationError(
        `Tag scope must be at most ${MAX_TAG_PART_LENGTH} characters`,
      );
    }
    if (CONTROL_CHARS.test(normScope)) {
      throw new ValidationError("Tag scope must not contain control characters");
    }
  }

  return { scope: normScope, value: trimmedValue };
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
 * Idempotent: the lower(scope), lower(value) expression unique index (spec-418 dec-8,
 * migration 0125) with NULLS NOT DISTINCT guarantees one row per canonical tag
 * CASE-INSENSITIVELY, so `priority::high` / `Priority::HIGH` resolve to one row and
 * `bug` / `BUG` (scope = null) never duplicate. Display keeps the first writer's casing.
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

  // Case-insensitive fallback (dec-8): match on lower(scope) AND lower(value), for
  // BOTH scoped and flat (scope IS NULL) tags, so a later case-variant resolves to the
  // existing row rather than minting a near-duplicate (e.g. "api" → "API",
  // "Deploy::Foo" → "DEPLOY::foo"). Flat tags can't use lower(scope)=lower(NULL) (that
  // is NULL, never true), so they match on `scope IS NULL` + lower(value). This is the
  // read side of the CI unique index (0125); the first-written casing is preserved
  // because we return the stored row and never rewrite it.
  const ciScopePred =
    scope === null ? isNull(tags.scope) : sql`lower(${tags.scope}) = lower(${scope})`;
  const ciMatch = and(
    eq(tags.memexId, memexId),
    ciScopePred,
    sql`lower(${tags.value}) = lower(${value})`,
  );
  const [ciExisting] = await db.select().from(tags).where(ciMatch).limit(1);
  if (ciExisting) return ciExisting;

  const created = await mutate(
    ctx,
    { memexId, entity: "tag", action: "created" },
    async () => {
      // onConflictDoNothing covers the race where a concurrent caller inserted the
      // same canonical tag (case-insensitively, per the 0125 index) between our
      // SELECT and INSERT.
      const [row] = await db
        .insert(tags)
        .values({ memexId, scope, value })
        .onConflictDoNothing()
        .returning();
      return row ?? null;
    },
  );
  if (created) return created;

  // Lost the create race. The winning row may be a CASE-VARIANT of what we tried to
  // insert (the CI index 0125 treats "api" and "API" as the same tag, so our INSERT
  // conflicted and returned null). Read back CASE-INSENSITIVELY — an exact (scope,
  // value) read would MISS a case-variant survivor and throw spuriously.
  const [row] = await db.select().from(tags).where(ciMatch).limit(1);
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

// ─── Tag curation (spec-418 t-2): create / rename / delete ───────────────────
// The catalogue-admin mutation set is EXACTLY {create, rename, delete} — no merge,
// ever (dec-2, ac-11/ac-12). These differ from the create-or-pick attach path above:
// createTag BLOCKS on a duplicate (getOrCreateTag silently returns the existing);
// renameTag/deleteTag operate on the catalogue row and fan an event out per affected
// Spec. Every write goes through mutate() with the caller's RequestCtx so channel
// attribution is correct (std-8/std-32, ac-19).

/** A catalogue tag plus how many Specs currently carry it. Feeds the admin list (t-5). */
export interface TagWithCount extends Tag {
  assignedCount: number;
}

/** The plain-reason DUPLICATE block, shared by createTag, renameTag's pre-check, and
 *  the renameTag race-mapping (ac-13/ac-38) so every path surfaces one message shape
 *  that NAMES the colliding tag. */
function duplicateBlock(existingLabel: string): ValidationError {
  return new ValidationError(`A tag named "${existingLabel}" already exists`);
}

/** True when a driver error is a Postgres unique-violation (SQLSTATE 23505). drizzle
 *  wraps the driver error, so the code can ride either on the error itself or `.cause`
 *  (see the t-1 CI-index test). */
function isUniqueViolation(err: unknown): boolean {
  const code =
    (err as { code?: string } | null)?.code ??
    (err as { cause?: { code?: string } } | null)?.cause?.code;
  return code === "23505";
}

/** Find a tag in this Memex whose (scope, value) matches CASE-INSENSITIVELY, or null.
 *  The read side of the 0125 CI unique index — used by the duplicate guards so a
 *  case-variant collision is caught before the write, not only at the index. Also the
 *  resolver the MCP rename_tag/delete_tag string path uses to honour dec-8 (an agent
 *  names a tag from memory in arbitrary casing; the case-sensitive findTag would 404 a
 *  tag that demonstrably exists as a single canonical row). */
export async function findTagCI(
  memexId: string,
  scope: string | null,
  value: string,
): Promise<Tag | null> {
  const ciScopePred =
    scope === null ? isNull(tags.scope) : sql`lower(${tags.scope}) = lower(${scope})`;
  const [row] = await db
    .select()
    .from(tags)
    .where(
      and(eq(tags.memexId, memexId), ciScopePred, sql`lower(${tags.value}) = lower(${value})`),
    )
    .limit(1);
  return row ?? null;
}

/** The Spec ids currently carrying a tag (tenant-scoped). Computed BEFORE a rename or
 *  delete so the mutate() key list can fan one `document` updated event per affected
 *  Spec while the underlying data change stays a single set-based statement (ac-16). */
async function docIdsCarryingTag(memexId: string, tagId: string): Promise<string[]> {
  const rows = await db
    .select({ docId: documentTags.docId })
    .from(documentTags)
    .where(and(eq(documentTags.memexId, memexId), eq(documentTags.tagId, tagId)));
  return rows.map((r) => r.docId);
}

/** Build the mutate() key list for a curation mutation that touches the tag row AND
 *  N Specs: one `tag` event (created/updated/deleted) + one `document` updated per
 *  affected Spec (ac-16/ac-39 — a single mutate() emits the whole fan-out atomically). */
function curationKeys(
  memexId: string,
  tagAction: "updated" | "deleted",
  affectedDocIds: string[],
): ChangeKey[] {
  return [
    { memexId, entity: "tag", action: tagAction },
    ...affectedDocIds.map(
      (docId): ChangeKey => ({ memexId, docId, entity: "document", action: "updated" }),
    ),
  ];
}

/**
 * Mint a NEW catalogue tag. Unlike getOrCreateTag (which silently returns an existing
 * row), createTag BLOCKS on a duplicate: it is the admin "add a tag" action, so a
 * collision is a user error to surface, not a silent no-op (ac-27). Validation runs at
 * the boundary before any write (ac-37). The ONLY block is the duplicate-name guard —
 * a brand-new catalogue tag is on no Spec, so the per-scope exclusivity rule can never
 * apply here (ac-29). Emits a single {entity:'tag', action:'created'} via mutate().
 */
export async function createTag(
  ctx: RequestCtx,
  memexId: string,
  scope: string | null,
  value: string,
): Promise<Mutated<Tag>> {
  const clean = validateTagInput(scope, value);

  const existing = await findTagCI(memexId, clean.scope, clean.value);
  if (existing) throw duplicateBlock(formatTag(existing));

  return mutate(ctx, { memexId, entity: "tag", action: "created" }, async () => {
    const [row] = await db
      .insert(tags)
      .values({ memexId, scope: clean.scope, value: clean.value })
      .returning();
    return row;
  });
}

/**
 * Rename a catalogue tag's (scope, value). Validates at the boundary (ac-37), then runs
 * two guards BEFORE any write, each a plain-reason block that changes NO row:
 *   (a) DUPLICATE (ac-13): a DIFFERENT tag already holds the target (scope, value)
 *       case-insensitively → block, naming the existing tag.
 *   (b) SCOPE-EXCLUSIVITY (ac-14): only when the new scope is non-null. If any Spec
 *       carries THIS tag AND some OTHER tag already in the new scope (a different
 *       value), the rename would leave that Spec with two values in one scope. Block
 *       with a reason that names the scope and SUMMARISES the count of affected Specs
 *       (never an enumeration). A single COUNT query.
 * The rename itself is a SINGLE set-based UPDATE inside ONE mutate() whose keys fan one
 * `document` updated event per affected Spec plus one `tag` updated event (ac-16/ac-39).
 * The UPDATE is wrapped so a lost check-then-write race (unique index, SQLSTATE 23505)
 * is re-thrown as the SAME duplicate block — never a raw DB error (ac-38).
 */
export async function renameTag(
  ctx: RequestCtx,
  memexId: string,
  tagId: string,
  newScope: string | null,
  newValue: string,
): Promise<Mutated<Tag>> {
  const clean = validateTagInput(newScope, newValue);

  const [tag] = await db
    .select()
    .from(tags)
    .where(and(eq(tags.id, tagId), eq(tags.memexId, memexId)))
    .limit(1);
  if (!tag) throw new NotFoundError(`Tag ${tagId} not found in this Memex`);

  // (a) DUPLICATE — a DIFFERENT tag already holds the target (scope, value) CI.
  const dupScopePred =
    clean.scope === null
      ? isNull(tags.scope)
      : sql`lower(${tags.scope}) = lower(${clean.scope})`;
  const [dup] = await db
    .select()
    .from(tags)
    .where(
      and(
        eq(tags.memexId, memexId),
        dupScopePred,
        sql`lower(${tags.value}) = lower(${clean.value})`,
        ne(tags.id, tagId),
      ),
    )
    .limit(1);
  if (dup) throw duplicateBlock(formatTag(dup));

  // (b) SCOPE-EXCLUSIVITY — only meaningful when moving INTO a scope. Count DISTINCT
  // Specs that carry THIS tag and ALSO carry some other tag already in the new scope
  // (a different value): those would end up with two values in one scope. One query.
  if (clean.scope !== null) {
    const [{ n }] = (await db.execute(sql`
      SELECT count(DISTINCT dt1.document_id)::int AS n
      FROM document_tags dt1
      JOIN document_tags dt2
        ON dt2.document_id = dt1.document_id AND dt2.memex_id = dt1.memex_id
      JOIN tags t2 ON t2.id = dt2.tag_id
      WHERE dt1.memex_id = ${memexId}
        AND dt1.tag_id = ${tagId}
        AND t2.id <> ${tagId}
        AND lower(t2.scope) = lower(${clean.scope})
        AND lower(t2.value) <> lower(${clean.value})
    `)) as unknown as Array<{ n: number }>;
    if (n > 0) {
      throw new ValidationError(
        `Renaming into the "${clean.scope}" scope would put two "${clean.scope}" ` +
          `values on ${n} Spec${n === 1 ? "" : "s"} that already use it. ` +
          `Resolve those first.`,
      );
    }
  }

  // Fan-out targets computed BEFORE the write; the data change is one set-based UPDATE.
  const affectedDocIds = await docIdsCarryingTag(memexId, tagId);

  return mutate(ctx, curationKeys(memexId, "updated", affectedDocIds), async () => {
    try {
      const [row] = await db
        .update(tags)
        .set({ scope: clean.scope, value: clean.value })
        .where(and(eq(tags.id, tagId), eq(tags.memexId, memexId)))
        .returning();
      return row;
    } catch (err) {
      // Lost the check-then-write race: a concurrent writer took (scope, value) between
      // our duplicate pre-check and this UPDATE. Map the CI-index violation to the SAME
      // duplicate block so the caller never sees a raw 23505 (ac-38).
      if (isUniqueViolation(err)) throw duplicateBlock(formatTag(clean));
      throw err;
    }
  });
}

/**
 * Delete a catalogue tag. NEVER blocks (ac-15): there is no invalid-state guard — an
 * admin deleting a tag always removes it. The single DELETE drops the tags row and the
 * FK cascade (document_tags.tag_id ON DELETE CASCADE) removes every link, leaving zero
 * orphans. Fan-out targets are captured BEFORE the delete so the ONE mutate() emits a
 * `tag` deleted event plus one `document` updated per affected Spec (ac-16/ac-39). The
 * blast radius (affected Spec ids / count) is returned so the caller can drive the t-6
 * confirmation copy.
 */
export async function deleteTag(
  ctx: RequestCtx,
  memexId: string,
  tagId: string,
): Promise<Mutated<{ removed: number; affectedDocIds: string[] }>> {
  const [tag] = await db
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.id, tagId), eq(tags.memexId, memexId)))
    .limit(1);
  if (!tag) throw new NotFoundError(`Tag ${tagId} not found in this Memex`);

  const affectedDocIds = await docIdsCarryingTag(memexId, tagId);

  return mutate(ctx, curationKeys(memexId, "deleted", affectedDocIds), async () => {
    const deleted = await db
      .delete(tags)
      .where(and(eq(tags.id, tagId), eq(tags.memexId, memexId)))
      .returning({ id: tags.id });
    return { removed: deleted.length, affectedDocIds };
  });
}

/**
 * The tag catalogue for a Memex with each tag's assigned-Spec count, computed in a
 * SINGLE aggregate query (LEFT JOIN document_tags GROUP BY tag) — never N per-tag
 * counts (ac-18/std-39). Orphan tags (on no Spec) report assignedCount 0. Ordered
 * scope-then-value for stable rendering. Feeds the admin catalogue view (t-5).
 */
export async function listMemexTagsWithCounts(memexId: string): Promise<TagWithCount[]> {
  return db
    .select({
      id: tags.id,
      memexId: tags.memexId,
      scope: tags.scope,
      value: tags.value,
      createdAt: tags.createdAt,
      assignedCount: sql<number>`count(${documentTags.docId})::int`,
    })
    .from(tags)
    .leftJoin(documentTags, eq(documentTags.tagId, tags.id))
    .where(eq(tags.memexId, memexId))
    .groupBy(tags.id)
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
