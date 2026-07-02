// spec-300 t-10 — the Skills SERVICE: the single server code path both the MCP
// tools (later task) and the React UI wrap. It WIRES the three pre-built layers,
// it does not re-implement them:
//
//   * t-1 (data)      — Skills are docType='skill' rows in `documents` with a
//                       nullable `description`, `skill_capabilities` (this task),
//                       and a `skill_files` manifest child table. Handles are
//                       minted `skill-N` by createDocDraft/nextSkillHandle.
//   * t-3 (transform) — parseSkillMd / validateSkill / reconstructSkillMd. Parse +
//                       validate on WRITE, reconstruct verbatim on READ.
//   * t-2 (storage)   — getStorageProvider(): binary auxiliary-file bytes live in
//                       the blob store, never Postgres (dec-19). Authorization is
//                       OUR job here; the provider only moves bytes.
//
// Every mutation goes through mutate() on the unified bus (std-8). Tenancy is
// caller-enforced: services receive an already-resolved memexId, and cross-Memex
// lookups 404 via NotFoundError (std-7).

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../db/connection.js";
import { documents, docSections, skillFiles, memexes, namespaces } from "../../db/schema.js";
import type { Doc, SkillFile } from "../../db/schema.js";
import { NotFoundError, ValidationError } from "../../types/errors.js";
import { mutate, forwardBrand, type Mutated, type RequestCtx } from "../mutate.js";
import { resolveActorColumns } from "../actor.js";
import { recordSkillUse } from "./skill-metering.js";
import { isUuid } from "../shared/identifiers.js";
import { createDocDraft } from "../documents.js";
import { getStorageProvider, type StorageProvider } from "../storage/index.js";
import { parseSkillMd } from "./parse-skill-md.js";
import { validateSkill } from "./validate-skill.js";
import { reconstructSkillMd } from "./reconstruct-skill-md.js";
import {
  normalizeCapabilities,
  DEFAULT_SKILL_CAPABILITIES,
  type SkillCapabilities,
} from "./skill-capabilities.js";
import {
  skillBlobKey,
  checksumOf,
  putSkillBlob,
  deleteSkillBlob,
} from "./skill-storage.js";

const SKILL_DOC_TYPE = "skill";

// ── Input / output shapes ─────────────────────────────────────────────────────

/** A text auxiliary file — stored INLINE in `text_content` (dec-19). */
export interface SkillTextFileInput {
  readonly path: string;
  readonly purpose?: string;
  /** MIME type; defaults to `text/plain` when omitted. */
  readonly contentType?: string;
  readonly text: string;
}

/** A binary auxiliary file — bytes go to the blob store (`storage_kind='bucket'`). */
export interface SkillBinaryFileInput {
  readonly path: string;
  readonly purpose?: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

export type SkillFileInput = SkillTextFileInput | SkillBinaryFileInput;

function isBinaryFile(f: SkillFileInput): f is SkillBinaryFileInput {
  return "bytes" in f && f.bytes !== undefined;
}

export interface CreateSkillInput {
  /** The full SKILL.md text — parsed + validated (t-3) before anything is stored. */
  readonly skillMd: string;
  /** Memex-native capability flags (dec-20). Defaults to all-false when omitted. */
  readonly capabilities?: unknown;
  /** Auxiliary files bundled with the Skill. Optional. */
  readonly files?: readonly SkillFileInput[];
  /** The original filename of the uploaded PRIMARY definition, when the create
   *  arrives from a file upload (drag-and-drop). When supplied it MUST be a
   *  `SKILL.md` — a non-SKILL.md primary is rejected BEFORE parsing (ac-9). MCP /
   *  in-app authors that hand raw SKILL.md text omit it. */
  readonly filename?: string;
}

export interface EditSkillInput {
  /** New SKILL.md text — re-parsed + validated; updates name/description/body. */
  readonly skillMd?: string;
  /** Replacement capability flags. */
  readonly capabilities?: unknown;
}

/** One table-of-contents entry — path + purpose + type + size, NEVER contents (ac-15). */
export interface SkillFileTocEntry {
  readonly path: string;
  readonly purpose: string | null;
  readonly contentType: string;
  readonly size: number;
}

/** The read shape: the verbatim SKILL.md plus a file TOC (no inline contents). */
export interface SkillView {
  readonly ref: string;
  readonly handle: string;
  readonly name: string;
  readonly description: string;
  readonly capabilities: SkillCapabilities;
  /** Verbatim SKILL.md, reconstructed from stored fields (t-3). */
  readonly skillMd: string;
  readonly files: readonly SkillFileTocEntry[];
  /** The Skill's meaningful last-edit time — max section updatedAt, so the UI can
   *  show a "last-updated" stamp on the detail view (spec-300 t-5). */
  readonly lastUpdatedAt: Date;
}

/** The list shape: metadata only — no body, no allowed-tools. */
export interface SkillListItem {
  readonly ref: string;
  readonly handle: string;
  readonly name: string;
  readonly description: string;
  readonly capabilities: SkillCapabilities;
  /** The Skill's meaningful last-edit time — max section updatedAt, so list-page
   *  cards can show "last-updated" (spec-300 t-5). */
  readonly lastUpdatedAt: Date;
}

/** One file's byte-access result. Bucket files hand back a short-TTL signed URL
 *  (ac-16); inline text files hand back the text directly (no blob to sign). */
export type SkillFileAccess =
  | { readonly kind: "inline"; readonly contentType: string; readonly text: string }
  | { readonly kind: "bucket"; readonly contentType: string; readonly url: string };

// ── Internal helpers ──────────────────────────────────────────────────────────

interface SkillDocRow extends Doc {
  namespaceSlug: string;
  memexSlug: string;
}

/** Load an ACTIVE Skill document by handle or id within the memex. Cross-Memex /
 *  wrong-docType / archived → NotFoundError (std-7). Also resolves the ns/mx slugs
 *  for canonical-ref building in one join. */
async function loadActiveSkillDoc(
  memexId: string,
  ref: string,
  opts: { includeArchived?: boolean } = {},
): Promise<SkillDocRow> {
  const idMatch = isUuid(ref)
    ? eq(documents.id, ref)
    : eq(documents.handle, ref);
  const [row] = await db
    .select({
      doc: documents,
      namespaceSlug: namespaces.slug,
      memexSlug: memexes.slug,
    })
    .from(documents)
    .innerJoin(memexes, eq(documents.memexId, memexes.id))
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(
      and(
        idMatch,
        eq(documents.memexId, memexId),
        eq(documents.docType, SKILL_DOC_TYPE),
        // Restore is the one path that must see an ARCHIVED skill; every other
        // caller stays active-only so archived skills are invisible (std-7).
        ...(opts.includeArchived ? [] : [isNull(documents.archivedAt)]),
      ),
    )
    .limit(1);
  if (!row) {
    throw new NotFoundError(`Skill ${ref} not found`);
  }
  return { ...row.doc, namespaceSlug: row.namespaceSlug, memexSlug: row.memexSlug };
}

/** Canonical Skill ref per std-10: `<namespace>/<memex>/skills/<skill-handle>`. */
function buildSkillRef(row: { namespaceSlug: string; memexSlug: string; handle: string }): string {
  return `${row.namespaceSlug}/${row.memexSlug}/skills/${row.handle}`;
}

/** The Skill's body lives in its first (lowest-seq) document section. */
async function firstSectionBody(docId: string): Promise<string> {
  const [section] = await db
    .select({ content: docSections.content })
    .from(docSections)
    .where(eq(docSections.docId, docId))
    .orderBy(asc(docSections.seq))
    .limit(1);
  return section?.content ?? "";
}

/** The Skill's meaningful last-edit time: the max `updatedAt` across its sections
 *  (bumped on every SKILL.md body edit). Falls back to `fallback` (the doc's own
 *  create/status timestamp) when the doc somehow has no sections. */
async function lastEditAt(docId: string, fallback: Date): Promise<Date> {
  const [row] = await db
    .select({ max: sql<Date | null>`max(${docSections.updatedAt})` })
    .from(docSections)
    .where(eq(docSections.docId, docId));
  return row?.max ?? fallback;
}

async function firstSectionId(docId: string): Promise<string | null> {
  const [section] = await db
    .select({ id: docSections.id })
    .from(docSections)
    .where(eq(docSections.docId, docId))
    .orderBy(asc(docSections.seq))
    .limit(1);
  return section?.id ?? null;
}

/** Guard the PRIMARY skill definition's filename (ac-9). A file offered as the
 *  skill definition must be a `SKILL.md`; a `.txt`/`.json`/anything-else primary is
 *  rejected with a user-visible error BEFORE any parsing. Auxiliary files are
 *  unaffected — they may be any type. A create that carries no filename (MCP /
 *  in-app authors handing raw SKILL.md text) skips the check. Basename-only and
 *  case-insensitive so `path/to/SKILL.md` and `Skill.md` are accepted. */
function assertSkillMdPrimary(filename: string | undefined): void {
  if (filename === undefined) return;
  const base = filename.split(/[\\/]/).pop() ?? filename;
  if (base.toLowerCase() !== "skill.md") {
    throw new ValidationError(
      `The primary skill definition must be a SKILL.md file (got "${base}"). ` +
        `Bundle other file types as auxiliary files instead.`,
    );
  }
}

/** Parse + validate a SKILL.md and return the authoritative fields. `name` and
 *  `description` are guaranteed present post-validate. */
function parseAndValidate(skillMd: string): {
  name: string;
  description: string;
  body: string;
} {
  const parsed = parseSkillMd(skillMd);
  validateSkill(parsed);
  // validateSkill guarantees non-blank name + description; narrow the optionals.
  return {
    name: parsed.name as string,
    description: parsed.description as string,
    body: parsed.body,
  };
}

/** Project a manifest row into a TOC entry (path/purpose/type/size only). */
function toTocEntry(f: SkillFile): SkillFileTocEntry {
  return { path: f.path, purpose: f.purpose, contentType: f.contentType, size: f.size };
}

/** Build the persisted manifest values for one input file (bytes handled by
 *  caller for binary; this shapes the row). */
async function buildFileRow(
  skillDocId: string,
  input: SkillFileInput,
): Promise<{
  skillDocId: string;
  path: string;
  purpose: string | null;
  contentType: string;
  size: number;
  checksum: string;
  storageKind: "inline" | "bucket";
  textContent: string | null;
  blobUri: string | null;
}> {
  const path = input.path?.trim();
  if (!path) {
    throw new ValidationError("Each skill file requires a non-empty path");
  }
  const purpose = input.purpose ?? null;

  if (isBinaryFile(input)) {
    const bytes = input.bytes;
    const key = skillBlobKey(skillDocId, path);
    await putSkillBlob(getStorageProvider(), key, bytes, input.contentType);
    return {
      skillDocId,
      path,
      purpose,
      contentType: input.contentType,
      size: bytes.byteLength,
      checksum: checksumOf(bytes),
      storageKind: "bucket",
      textContent: null,
      blobUri: key,
    };
  }

  const bytes = Buffer.from(input.text, "utf8");
  return {
    skillDocId,
    path,
    purpose,
    contentType: input.contentType ?? "text/plain",
    size: bytes.byteLength,
    checksum: checksumOf(bytes),
    storageKind: "inline",
    textContent: input.text,
    blobUri: null,
  };
}

// ── Public service surface ────────────────────────────────────────────────────

/**
 * Create a Skill. Parses + validates the SKILL.md (t-3), mints a `skill-N`
 * docType='skill' document (title = SKILL.md name, first section = body) via
 * createDocDraft, stamps the `description` + `skill_capabilities` columns, and
 * persists any auxiliary `files` into the `skill_files` manifest (text inline,
 * binary to the blob store). Every write flows through mutate() (std-8).
 */
export async function createSkill(
  memexId: string,
  input: CreateSkillInput,
  ctx: RequestCtx = {},
): Promise<Mutated<SkillView>> {
  // ac-9 — reject a non-SKILL.md PRIMARY file before we parse anything.
  assertSkillMdPrimary(input.filename);
  const { name, description, body } = parseAndValidate(input.skillMd);
  const capabilities = normalizeCapabilities(input.capabilities);

  // dec-14 / ac-36 — Skill names are unique within a Memex. Enforced HERE in the
  // service so REST, the React UI, and MCP all get the same guard (the check no
  // longer lives only in the MCP create branch). Case-insensitive against active
  // skills; a collision is a user-visible validation error, not a silent second row.
  const existing = await listSkills(memexId);
  const clash = existing.find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (clash) {
    throw new ValidationError(
      `A skill named "${name}" already exists in this Memex (${clash.ref}). ` +
        `Pick a different name, or edit the existing skill.`,
    );
  }

  // 1. Mint the doc + first section (content = SKILL.md body). createDocDraft
  //    emits document/created through mutate().
  const doc = await createDocDraft(
    memexId,
    name,
    body,
    SKILL_DOC_TYPE,
    undefined,
    undefined,
    ctx.actorUserId,
    ctx,
  );

  // Steps 2-3 run AFTER the doc is committed (step 1), and each mutate() is its
  // own transaction — so a failure here (e.g. a binary blob upload to an
  // unprovisioned store) would orphan a half-created skill: the doc persists
  // while the caller sees a 500 (spec-300 issue-3, observed as skill-2). Wrap
  // them so a failure rolls the create back atomically before rethrowing the
  // real cause.
  try {
    // 2. Stamp the Skill-specific columns on the doc row (document/updated).
    const updated = await mutate(
      ctx,
      { memexId, docId: doc.id, entity: "document", action: "updated" },
      async () => {
        const [row] = await db
          .update(documents)
          .set({ description, skillCapabilities: capabilities })
          .where(and(eq(documents.id, doc.id), eq(documents.memexId, memexId)))
          .returning();
        return row;
      },
    );

    // 3. Persist the auxiliary-file manifest (one skill_file/created event per row).
    let fileRows: SkillFile[] = [];
    const files = input.files ?? [];
    if (files.length > 0) {
      const values = await Promise.all(files.map((f) => buildFileRow(doc.id, f)));
      fileRows = await mutate(
        ctx,
        values.map(() => ({
          memexId,
          docId: doc.id,
          entity: "skill_file" as const,
          action: "created" as const,
        })),
        async () => db.insert(skillFiles).values(values).returning(),
      );
    }

    // createDocDraft doesn't return ns/mx slugs; resolve them so the returned view
    // carries the canonical ref exactly like getSkill does.
    const ref = await resolveSkillRef(memexId, updated.handle);
    const view: SkillView = {
      ref,
      handle: updated.handle,
      name: updated.title,
      description,
      capabilities,
      skillMd: reconstructSkillMd({ name: updated.title, description, body }),
      files: fileRows.map(toTocEntry),
      lastUpdatedAt: await lastEditAt(doc.id, updated.statusChangedAt),
    };
    // The doc-column update is a genuine mutate() witness; forward its brand to the
    // composite view (the ONE sanctioned brand transfer, mutate.ts forwardBrand).
    return forwardBrand(updated, view);
  } catch (err) {
    await rollbackPartialSkillCreate(memexId, doc.id, input.files ?? [], ctx);
    throw err;
  }
}

/** Compensating rollback for a createSkill that failed AFTER its doc was
 *  committed (spec-300 issue-3, ac-44). Removes any auxiliary blobs written for
 *  this doc, then hard-deletes the doc through mutate() so the unified bus stays
 *  consistent — step 1's document/created is balanced by a document/deleted, and
 *  FK ON DELETE CASCADE clears the skill_files manifest. Best-effort throughout:
 *  a cleanup failure must never mask the original error the caller is about to
 *  see rethrown. */
async function rollbackPartialSkillCreate(
  memexId: string,
  docId: string,
  files: readonly SkillFileInput[],
  ctx: RequestCtx,
): Promise<void> {
  // Blobs first. getStorageProvider() itself throws when storage is unconfigured
  // — a common cause of the very failure we're rolling back — in which case
  // nothing was uploaded, so skip silently.
  let provider: StorageProvider | null = null;
  try {
    provider = getStorageProvider();
  } catch {
    provider = null;
  }
  if (provider) {
    for (const f of files) {
      const path = f.path?.trim();
      if (isBinaryFile(f) && path) {
        try {
          await deleteSkillBlob(provider, skillBlobKey(docId, path));
        } catch {
          // best-effort — a stranded blob is far less bad than masking the cause
        }
      }
    }
  }
  try {
    await mutate(
      ctx,
      { memexId, docId, entity: "document", action: "deleted" },
      async () => {
        const [row] = await db
          .delete(documents)
          .where(and(eq(documents.id, docId), eq(documents.memexId, memexId)))
          .returning();
        return row;
      },
    );
  } catch {
    // best-effort — if even the compensating delete fails, still rethrow the
    // original cause; an orphan is a lesser evil than swallowing the real error.
  }
}

/** Resolve `<namespace>/<memex>/skills/<handle>` from a memexId + handle. */
async function resolveSkillRef(memexId: string, handle: string): Promise<string> {
  const [row] = await db
    .select({ namespaceSlug: namespaces.slug, memexSlug: memexes.slug })
    .from(memexes)
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(memexes.id, memexId))
    .limit(1);
  return row ? `${row.namespaceSlug}/${row.memexSlug}/skills/${handle}` : handle;
}

/**
 * Edit a Skill's SKILL.md (name/description/body) and/or capability flags. Title,
 * `description`, the first section body, and `skill_capabilities` are updated in
 * one document/updated mutation. Auxiliary-file manifest edits are out of scope
 * for this surface (they arrive with the file-upload flow).
 */
export async function editSkill(
  memexId: string,
  ref: string,
  input: EditSkillInput,
  ctx: RequestCtx = {},
): Promise<Mutated<SkillView>> {
  const doc = await loadActiveSkillDoc(memexId, ref);

  const parsed = input.skillMd !== undefined ? parseAndValidate(input.skillMd) : null;
  const capabilities =
    input.capabilities !== undefined ? normalizeCapabilities(input.capabilities) : null;

  const updated = await mutate(
    ctx,
    { memexId, docId: doc.id, entity: "document", action: "updated" },
    async () => {
      const [row] = await db
        .update(documents)
        .set({
          ...(parsed ? { title: parsed.name, description: parsed.description } : {}),
          ...(capabilities ? { skillCapabilities: capabilities } : {}),
        })
        .where(and(eq(documents.id, doc.id), eq(documents.memexId, memexId)))
        .returning();
      return row;
    },
  );

  // When the SKILL.md changed, rewrite the first section body in the same logical
  // edit (section/updated) so the reconstructed SKILL.md stays verbatim.
  if (parsed) {
    const sectionId = await firstSectionId(doc.id);
    if (sectionId) {
      await mutate(
        ctx,
        { memexId, docId: doc.id, entity: "section", action: "updated" },
        async () => {
          const [row] = await db
            .update(docSections)
            .set({
              content: parsed.body,
              updatedAt: new Date(),
              ...(await resolveActorColumns(ctx)),
            })
            .where(eq(docSections.id, sectionId))
            .returning();
          return row;
        },
      );
    }
  }

  const body = parsed ? parsed.body : await firstSectionBody(doc.id);
  const description = updated.description ?? "";
  const caps = updated.skillCapabilities ?? DEFAULT_SKILL_CAPABILITIES;
  const view: SkillView = {
    ref: buildSkillRef({ ...doc, handle: updated.handle }),
    handle: updated.handle,
    name: updated.title,
    description,
    capabilities: caps,
    skillMd: reconstructSkillMd({ name: updated.title, description, body }),
    files: await listTocFor(doc.id),
    lastUpdatedAt: await lastEditAt(doc.id, updated.statusChangedAt),
  };
  return forwardBrand(updated, view);
}

/**
 * Soft-delete a Skill by stamping `archived_at` (consistent with documents).
 * Idempotent: an already-archived Skill succeeds without a second write. Emits
 * document/updated (std-8).
 */
export async function archiveSkill(
  memexId: string,
  ref: string,
  ctx: RequestCtx = {},
): Promise<Mutated<Doc>> {
  const doc = await loadActiveSkillDoc(memexId, ref);
  return mutate(
    ctx,
    { memexId, docId: doc.id, entity: "document", action: "updated" },
    async () => {
      const [row] = await db
        .update(documents)
        .set({ archivedAt: new Date() })
        .where(and(eq(documents.id, doc.id), eq(documents.memexId, memexId)))
        .returning();
      return row;
    },
  );
}

/** Alias — DELETE and archive are the same soft-delete for Skills. */
export const deleteSkill = archiveSkill;

/**
 * Restore (un-archive) a soft-deleted Skill by clearing `archived_at` (ac-10).
 * Archiving is non-destructive: the doc, its section body, capability flags, and
 * `skill_files` manifest were preserved, so a restore simply re-surfaces the Skill
 * in `listSkills`, `getSkill`, and the agent skill catalogue. Loads with
 * `includeArchived` (the one caller allowed to see an archived skill); a
 * cross-Memex / non-skill / unknown ref still 404s (std-7). Idempotent: restoring
 * an already-active Skill succeeds without a second write. Emits document/updated
 * (std-8).
 */
export async function restoreSkill(
  memexId: string,
  ref: string,
  ctx: RequestCtx = {},
): Promise<Mutated<Doc>> {
  const doc = await loadActiveSkillDoc(memexId, ref, { includeArchived: true });
  return mutate(
    ctx,
    { memexId, docId: doc.id, entity: "document", action: "updated" },
    async () => {
      const [row] = await db
        .update(documents)
        .set({ archivedAt: null })
        .where(and(eq(documents.id, doc.id), eq(documents.memexId, memexId)))
        .returning();
      return row;
    },
  );
}

/** Load the TOC (path/purpose/type/size) for a Skill's manifest, sorted by path. */
async function listTocFor(skillDocId: string): Promise<SkillFileTocEntry[]> {
  const rows = await db
    .select()
    .from(skillFiles)
    .where(eq(skillFiles.skillDocId, skillDocId))
    .orderBy(asc(skillFiles.path));
  return rows.map(toTocEntry);
}

/** Options for a Skill body read — carries the metering context (dec-21). */
export interface GetSkillOptions {
  /** The Spec ref this read serves, threaded onto the usage event (the inverse
   *  view's key). Omitted when the caller has no working Spec. */
  readonly workingSpecRef?: string;
}

/**
 * Read one Skill: the verbatim SKILL.md (reconstructed from stored fields, t-3)
 * plus a file TABLE-OF-CONTENTS (path + purpose + content_type + size) — NEVER
 * inline file contents (ac-15). Cross-Memex / archived / non-skill → 404 (std-7).
 *
 * A BODY fetch is the intent-to-use signal (dec-21): on success it emits exactly
 * ONE `skill.used` usage event carrying the skill, the working-Spec ref, the actor,
 * the channel, and the time. `list_skills` emits nothing — an appearance is not a
 * use. The emit is advisory (recordSkillUse swallows its own failures) so metering
 * never breaks a read.
 */
export async function getSkill(
  memexId: string,
  ref: string,
  ctx: RequestCtx = {},
  opts: GetSkillOptions = {},
): Promise<SkillView> {
  const doc = await loadActiveSkillDoc(memexId, ref);
  const body = await firstSectionBody(doc.id);
  const description = doc.description ?? "";
  const capabilities = doc.skillCapabilities ?? DEFAULT_SKILL_CAPABILITIES;
  const view: SkillView = {
    ref: buildSkillRef(doc),
    handle: doc.handle,
    name: doc.title,
    description,
    capabilities,
    skillMd: reconstructSkillMd({ name: doc.title, description, body }),
    files: await listTocFor(doc.id),
    lastUpdatedAt: await lastEditAt(doc.id, doc.statusChangedAt),
  };

  // dec-21 — one usage event per body fetch (skill, working-Spec ref, actor,
  // channel, time). Advisory; awaited so callers/tests observe the recorded row.
  await recordSkillUse({
    memexId,
    skillDocId: doc.id,
    skillHandle: doc.handle,
    skillRef: view.ref,
    ...(opts.workingSpecRef !== undefined ? { workingSpecRef: opts.workingSpecRef } : {}),
    ctx,
  });

  return view;
}

/**
 * Mint byte access for ONE Skill auxiliary file, AFTER the caller has verified
 * Memex access. Bucket files return a short-TTL signed read URL (t-2, ac-16);
 * inline text files return the text directly. Unknown path / cross-Memex → 404.
 */
export async function getSkillFile(
  memexId: string,
  ref: string,
  path: string,
): Promise<SkillFileAccess> {
  const doc = await loadActiveSkillDoc(memexId, ref);
  const [file] = await db
    .select()
    .from(skillFiles)
    .where(and(eq(skillFiles.skillDocId, doc.id), eq(skillFiles.path, path)))
    .limit(1);
  if (!file) {
    throw new NotFoundError(`Skill file ${path} not found`);
  }
  if (file.storageKind === "inline") {
    return { kind: "inline", contentType: file.contentType, text: file.textContent ?? "" };
  }
  if (!file.blobUri) {
    throw new NotFoundError(`Skill file ${path} not found`);
  }
  const url = await getStorageProvider().getSignedReadUrl(file.blobUri);
  return { kind: "bucket", contentType: file.contentType, url };
}

/**
 * List a Memex's ACTIVE Skills, alphabetical by name, returning metadata only
 * (`name`, `description`, `capabilities`, `ref`) — no body, no allowed-tools.
 */
export async function listSkills(memexId: string): Promise<SkillListItem[]> {
  // Per-doc meaningful last-edit = max section updatedAt, joined in so a card can
  // show "last-updated" without an N+1 (spec-300 t-5).
  const lastEdit = db
    .select({
      docId: docSections.docId,
      lastUpdatedAt: sql<Date>`max(${docSections.updatedAt})`.as("last_updated_at"),
    })
    .from(docSections)
    .groupBy(docSections.docId)
    .as("last_edit");

  const rows = await db
    .select({
      handle: documents.handle,
      title: documents.title,
      description: documents.description,
      skillCapabilities: documents.skillCapabilities,
      namespaceSlug: namespaces.slug,
      memexSlug: memexes.slug,
      statusChangedAt: documents.statusChangedAt,
      lastUpdatedAt: lastEdit.lastUpdatedAt,
    })
    .from(documents)
    .innerJoin(memexes, eq(documents.memexId, memexes.id))
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .leftJoin(lastEdit, eq(lastEdit.docId, documents.id))
    .where(
      and(
        eq(documents.memexId, memexId),
        eq(documents.docType, SKILL_DOC_TYPE),
        isNull(documents.archivedAt),
      ),
    )
    .orderBy(asc(documents.title));
  return rows.map((r) => ({
    ref: `${r.namespaceSlug}/${r.memexSlug}/skills/${r.handle}`,
    handle: r.handle,
    name: r.title,
    description: r.description ?? "",
    capabilities: r.skillCapabilities ?? DEFAULT_SKILL_CAPABILITIES,
    lastUpdatedAt: r.lastUpdatedAt ?? r.statusChangedAt,
  }));
}
