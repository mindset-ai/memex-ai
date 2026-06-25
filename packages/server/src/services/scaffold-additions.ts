// Per-Org scaffold guidance additions (b-68 dec-2 / dec-3).
//
// Service layer over the `org_scaffold_additions` table. The table itself IS
// the `source: 'org'` discriminator (b-68 dec-3): there is no `source` column,
// because there's no schema path to write `source: 'base'`. Every row this
// module reads is rendered as a `GuidanceBlock` with `source: 'org'` set in
// code; every write goes through `mutate()` and emits an `org_scaffold_addition`
// event on the std-8 bus so subscribers (the projection cache landing in t-11,
// the React Inspect UI in t-12+) refetch immediately.
//
// Read mapping (DB row → GuidanceBlock):
//   - `display_order` → `order` (column name avoids the SQL reserved word)
//   - `target_phase / target_tool / target_transition / target_button` →
//     `target: { phase?, tool?, transition?, button? }` where NULL columns are
//     absent from the target object (matches every value per b-68 dec-1).
//     `target_button` (spec-103 D-7) attaches a block to a Prompt Button id.
//   - `kind` is hard-coded to `'guidance_block'`; `source` is hard-coded to
//     `'org'`. Neither lives in the DB.
//   - The DB primary key surfaces as a `.id` field on the returned view so
//     the HTTP route in t-10 has a stable handle to PATCH/DELETE against. The
//     shared `GuidanceBlock` shape doesn't carry `id` because base blocks
//     have no persisted identity — they live in code.
//
// std-8 wiring:
//   - entity: `org_scaffold_addition`
//   - actions: `created` | `updated` | `deleted`
//   - memexId on the event: the org's primary memex (mirrors org_memberships
//     so the per-Memex SSE stream in any tab under the org's namespace refetches)
//   - The bus event payload is the bare std-8 shape — no extra fields. The
//     orgId lives one resolver step downstream (memex → namespace → org), so
//     subscribers (the projection cache in t-11) resolve the org from the
//     emitted memexId rather than us widening the std-8 event surface.

import { and, asc, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { memexes, namespaces, orgScaffoldAdditions } from "../db/schema.js";
import type {
  OrgScaffoldAddition,
  OrgScaffoldAdditionInsert,
} from "../db/schema.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import { mutate, type Mutated, type RequestCtx } from "./mutate.js";
import { primaryMemexIdForOrg } from "./shared/memex-ownership.js";
import type {
  GuidanceBlock,
  GuidanceEmphasis,
  GuidanceTarget,
  Phase,
  Transition,
} from "@memex/shared";

// ──────────────────────────────────────────────────────────────────────────
// Output view: GuidanceBlock + the persisted `id` so the HTTP layer (t-10)
// can address the row for PATCH/DELETE. Base GuidanceBlocks have no `id`
// because they live in code; Org rows do, so we project it onto the view.
// ──────────────────────────────────────────────────────────────────────────

export interface OrgScaffoldAdditionView extends GuidanceBlock {
  id: string;
  // spec-360 follow-up: the personal-namespace owner of this row, when it is
  // personally owned (org_id NULL). Present only on personal-owned rows; org
  // rows leave it absent and carry `orgId` instead. The HTTP cross-tenant guard
  // reads this to confirm a row belongs to the caller's namespace.
  namespaceId?: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Owner model (spec-360 follow-up). An addition is owned by an org OR a
// personal namespace — additive namespace ownership. The owner discriminates
// which column the row's owner_id lives in (org_id vs namespace_id), enforced
// by the DB owner-XOR check. Every CORE read/write threads a ScaffoldOwner so
// a personal owner only ever touches THEIR namespace's rows and an org admin
// only their org's — neither can leak into the other.
// ──────────────────────────────────────────────────────────────────────────

export type ScaffoldOwner =
  | { kind: "org"; orgId: string }
  | { kind: "personal"; namespaceId: string };

// The owner-column predicate for reads/cross-tenant guards.
function ownerWhere(owner: ScaffoldOwner) {
  return owner.kind === "org"
    ? eq(orgScaffoldAdditions.orgId, owner.orgId)
    : eq(orgScaffoldAdditions.namespaceId, owner.namespaceId);
}

// Does this row belong to that owner? Used by route cross-tenant guards.
export function rowBelongsToOwner(
  row: OrgScaffoldAddition,
  owner: ScaffoldOwner,
): boolean {
  return owner.kind === "org"
    ? row.orgId === owner.orgId
    : row.namespaceId === owner.namespaceId;
}

// ──────────────────────────────────────────────────────────────────────────
// Input shapes.
// ──────────────────────────────────────────────────────────────────────────

export interface CreateOrgScaffoldAdditionInput {
  orgId: string;
  authorId: string;
  target: GuidanceTarget;
  text: string;
  rationale: string;
  emphasis?: GuidanceEmphasis;
  enabled?: boolean;
  order?: number;
  // spec-193 t-5: optional per-memex scope. Omitted / null = account-wide.
  memexId?: string | null;
}

export interface UpdateOrgScaffoldAdditionInput {
  text?: string;
  rationale?: string;
  target?: GuidanceTarget;
  // `null` clears the emphasis column. Omitting the field leaves it untouched.
  emphasis?: GuidanceEmphasis | null;
  enabled?: boolean;
  order?: number;
  // spec-193 t-5: re-scope the row. `null` clears it back to account-wide;
  // omitting the field leaves the scope untouched.
  memexId?: string | null;
}

export interface ListOrgScaffoldAdditionsFilters {
  enabledOnly?: boolean;
}

// ──────────────────────────────────────────────────────────────────────────
// Validation.
// ──────────────────────────────────────────────────────────────────────────

const VALID_PHASES: ReadonlySet<Phase> = new Set([
  "draft",
  "specify",
  "build",
  "verify",
  "done",
]);
const VALID_TRANSITIONS: ReadonlySet<Transition> = new Set([
  "specify",
  "build",
  "verify",
  "done",
]);
const VALID_EMPHASIS: ReadonlySet<GuidanceEmphasis> = new Set(["do", "dont"]);

function validateTarget(target: GuidanceTarget): void {
  if (target.phase !== undefined && !VALID_PHASES.has(target.phase)) {
    throw new ValidationError(`target.phase '${target.phase}' is not a valid Phase`);
  }
  if (target.transition !== undefined && !VALID_TRANSITIONS.has(target.transition)) {
    throw new ValidationError(
      `target.transition '${target.transition}' is not a valid Transition`,
    );
  }
  if (target.tool !== undefined && target.tool.length === 0) {
    throw new ValidationError("target.tool must be a non-empty string when present");
  }
  if (target.button !== undefined && target.button.length === 0) {
    throw new ValidationError("target.button must be a non-empty string when present");
  }
}

function validateEmphasis(emphasis: GuidanceEmphasis): void {
  if (!VALID_EMPHASIS.has(emphasis)) {
    throw new ValidationError(`emphasis '${emphasis}' is not 'do' or 'dont'`);
  }
}

function validateText(value: string, field: "text" | "rationale"): void {
  if (value.trim().length === 0) {
    throw new ValidationError(`${field} must be a non-empty string`);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Read mapping: DB row → GuidanceBlock.
//
// `kind` and `source` are hard-coded — they live in code, not in the DB. This
// is the inverse of the dec-3 invariant on the write side: the table is the
// `source: 'org'` discriminator, so reads always surface `source: 'org'`.
// ──────────────────────────────────────────────────────────────────────────

function toView(row: OrgScaffoldAddition): OrgScaffoldAdditionView {
  const target: GuidanceTarget = {};
  if (row.targetPhase !== null) target.phase = row.targetPhase as Phase;
  if (row.targetTool !== null) target.tool = row.targetTool;
  if (row.targetTransition !== null) target.transition = row.targetTransition as Transition;
  if (row.targetButton !== null) target.button = row.targetButton;

  const view: OrgScaffoldAdditionView = {
    kind: "guidance_block",
    source: "org",
    id: row.id,
    target,
    text: row.text,
    rationale: row.rationale,
    enabled: row.enabled,
    order: row.displayOrder,
    authorId: row.authorId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  // Owner discriminator (spec-360 follow-up): exactly one of org_id /
  // namespace_id is set. Org rows surface `orgId` (the existing field); personal
  // rows surface `namespaceId`. `source` stays 'org' on both — the table is the
  // `source: 'org'` discriminator regardless of which owner column is set.
  if (row.orgId !== null) view.orgId = row.orgId;
  if (row.namespaceId !== null) view.namespaceId = row.namespaceId;
  // spec-193 t-5: surface the per-memex scope. NULL column = account-wide, so
  // the field is left absent (mirrors how NULL target columns are absent).
  if (row.memexId !== null) view.memexId = row.memexId;
  if (row.emphasis !== null) {
    view.emphasis = row.emphasis as GuidanceEmphasis;
  }
  return view;
}

// ──────────────────────────────────────────────────────────────────────────
// Bus emission helper. Mirrors org_memberships.ts: scaffold-addition events
// fire on the org's primary memex so any tab under the org's namespace
// refetches. Empty-string fallback keeps the emit shape valid in the
// pathological no-memex-under-namespace state (subscribers filter on memexId).
// ──────────────────────────────────────────────────────────────────────────

async function memexKeyForOrg(orgId: string): Promise<string> {
  const id = await primaryMemexIdForOrg(orgId);
  return id ?? "";
}

// spec-360 follow-up: the personal-owner sibling of memexKeyForOrg. A personal
// namespace has exactly one memex (the 'personal' memex); resolve it so the
// std-8 bus event fires on that memex and any tab under the namespace refetches.
// Empty-string fallback keeps the emit shape valid in the pathological no-memex
// state (subscribers filter on memexId).
async function memexKeyForNamespace(namespaceId: string): Promise<string> {
  const [row] = await db
    .select({ id: memexes.id })
    .from(memexes)
    .where(eq(memexes.namespaceId, namespaceId))
    .limit(1);
  return row?.id ?? "";
}

// Resolve the bus-event memex key for either owner kind.
async function memexKeyForOwner(owner: ScaffoldOwner): Promise<string> {
  return owner.kind === "org"
    ? memexKeyForOrg(owner.orgId)
    : memexKeyForNamespace(owner.namespaceId);
}

// spec-360 follow-up: resolve the ScaffoldOwner for a memex — the join
// memex→namespace. An org-owned namespace → {kind:'org'}; a personal namespace
// (owner_user_id set, no org) → {kind:'personal'}. Returns null in the
// pathological no-namespace state. Co-located here so the agent context-builder
// and the propose_scaffold_change gate both thread the SAME owner resolution.
export async function resolveScaffoldOwner(
  memexId: string,
): Promise<ScaffoldOwner | null> {
  const [row] = await db
    .select({
      ownerOrgId: namespaces.ownerOrgId,
      ownerUserId: namespaces.ownerUserId,
      namespaceId: namespaces.id,
    })
    .from(memexes)
    .innerJoin(namespaces, eq(namespaces.id, memexes.namespaceId))
    .where(eq(memexes.id, memexId))
    .limit(1);
  if (!row) return null;
  if (row.ownerOrgId) return { kind: "org", orgId: row.ownerOrgId };
  if (row.ownerUserId) return { kind: "personal", namespaceId: row.namespaceId };
  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// Owner-aware CORE surface (spec-360 follow-up).
//
// These are the canonical implementations, keyed by a ScaffoldOwner so the
// owner column (org_id vs namespace_id) is set / filtered accordingly. The
// org-named functions below are thin wrappers that pass {kind:'org'} — so EVERY
// existing org caller (assess_brief hot path, cache, routes, tools) is untouched
// and behaves identically.
// ──────────────────────────────────────────────────────────────────────────

export interface CreateScaffoldAdditionInput {
  authorId: string;
  target: GuidanceTarget;
  text: string;
  rationale: string;
  emphasis?: GuidanceEmphasis;
  enabled?: boolean;
  order?: number;
  memexId?: string | null;
}

export async function listScaffoldAdditions(
  owner: ScaffoldOwner,
  filters: ListOrgScaffoldAdditionsFilters = {},
): Promise<OrgScaffoldAdditionView[]> {
  const where = filters.enabledOnly
    ? and(ownerWhere(owner), eq(orgScaffoldAdditions.enabled, true))
    : ownerWhere(owner);

  const rows = await db
    .select()
    .from(orgScaffoldAdditions)
    .where(where)
    .orderBy(asc(orgScaffoldAdditions.displayOrder), asc(orgScaffoldAdditions.createdAt));

  return rows.map(toView);
}

export async function createScaffoldAddition(
  owner: ScaffoldOwner,
  input: CreateScaffoldAdditionInput,
  ctx: RequestCtx = {},
): Promise<Mutated<OrgScaffoldAdditionView>> {
  validateText(input.text, "text");
  validateText(input.rationale, "rationale");
  validateTarget(input.target);
  if (input.emphasis !== undefined) validateEmphasis(input.emphasis);

  const memexId = await memexKeyForOwner(owner);

  const insertValues: OrgScaffoldAdditionInsert = {
    // Owner-XOR: exactly one column is set. The OTHER stays NULL (its default).
    orgId: owner.kind === "org" ? owner.orgId : null,
    namespaceId: owner.kind === "personal" ? owner.namespaceId : null,
    authorId: input.authorId,
    // spec-193 t-5: NULL = account-wide; a memex UUID = scoped to that memex.
    memexId: input.memexId ?? null,
    targetPhase: input.target.phase ?? null,
    targetTool: input.target.tool ?? null,
    targetTransition: input.target.transition ?? null,
    targetButton: input.target.button ?? null,
    text: input.text,
    rationale: input.rationale,
    emphasis: input.emphasis ?? null,
    enabled: input.enabled ?? true,
    displayOrder: input.order ?? 0,
  };

  return mutate(
    ctx,
    { memexId, entity: "org_scaffold_addition", action: "created" },
    async () => {
      const [row] = await db
        .insert(orgScaffoldAdditions)
        .values(insertValues)
        .returning();
      return toView(row);
    },
  );
}

export async function updateScaffoldAddition(
  id: string,
  input: UpdateOrgScaffoldAdditionInput,
  ctx: RequestCtx = {},
): Promise<Mutated<OrgScaffoldAdditionView>> {
  if (input.text !== undefined) validateText(input.text, "text");
  if (input.rationale !== undefined) validateText(input.rationale, "rationale");
  if (input.target !== undefined) validateTarget(input.target);
  if (input.emphasis !== undefined && input.emphasis !== null) {
    validateEmphasis(input.emphasis);
  }

  const existing = await db.query.orgScaffoldAdditions.findFirst({
    where: eq(orgScaffoldAdditions.id, id),
  });
  if (!existing) throw new NotFoundError(`Scaffold addition ${id} not found`);

  // Resolve the bus key from whichever owner column this row carries.
  const memexId = existing.orgId
    ? await memexKeyForOrg(existing.orgId)
    : existing.namespaceId
      ? await memexKeyForNamespace(existing.namespaceId)
      : "";

  // Build a partial update set. Each field is only included when the caller
  // explicitly passed it — `undefined` means "leave alone", `null` (for
  // emphasis) means "clear it".
  const set: Partial<OrgScaffoldAdditionInsert> = { updatedAt: new Date() };
  if (input.text !== undefined) set.text = input.text;
  if (input.rationale !== undefined) set.rationale = input.rationale;
  if (input.target !== undefined) {
    set.targetPhase = input.target.phase ?? null;
    set.targetTool = input.target.tool ?? null;
    set.targetTransition = input.target.transition ?? null;
    set.targetButton = input.target.button ?? null;
  }
  if (input.emphasis !== undefined) {
    set.emphasis = input.emphasis;
  }
  if (input.enabled !== undefined) set.enabled = input.enabled;
  if (input.order !== undefined) set.displayOrder = input.order;
  // spec-193 t-5: re-scope. `null` clears back to account-wide; `undefined`
  // leaves the existing scope untouched.
  if (input.memexId !== undefined) set.memexId = input.memexId;

  return mutate(
    ctx,
    { memexId, entity: "org_scaffold_addition", action: "updated" },
    async () => {
      const [row] = await db
        .update(orgScaffoldAdditions)
        .set(set)
        .where(eq(orgScaffoldAdditions.id, id))
        .returning();
      return toView(row);
    },
  );
}

export async function toggleScaffoldAddition(
  id: string,
  enabled: boolean,
  ctx: RequestCtx = {},
): Promise<Mutated<OrgScaffoldAdditionView>> {
  return updateScaffoldAddition(id, { enabled }, ctx);
}

export async function deleteScaffoldAddition(
  id: string,
  ctx: RequestCtx = {},
): Promise<Mutated<void>> {
  const existing = await db.query.orgScaffoldAdditions.findFirst({
    where: eq(orgScaffoldAdditions.id, id),
  });
  if (!existing) throw new NotFoundError(`Scaffold addition ${id} not found`);

  const memexId = existing.orgId
    ? await memexKeyForOrg(existing.orgId)
    : existing.namespaceId
      ? await memexKeyForNamespace(existing.namespaceId)
      : "";

  return mutate(
    ctx,
    { memexId, entity: "org_scaffold_addition", action: "deleted" },
    async () => {
      await db.delete(orgScaffoldAdditions).where(eq(orgScaffoldAdditions.id, id));
    },
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Org-named wrappers — the ORIGINAL public surface, preserved byte-for-byte in
// behaviour. Every existing caller keeps working; only the owner is fixed to
// {kind:'org'} here. (spec-360 follow-up — backward-compat shim.)
// ──────────────────────────────────────────────────────────────────────────

export async function listOrgScaffoldAdditions(
  orgId: string,
  filters: ListOrgScaffoldAdditionsFilters = {},
): Promise<OrgScaffoldAdditionView[]> {
  return listScaffoldAdditions({ kind: "org", orgId }, filters);
}

export async function getOrgScaffoldAddition(
  id: string,
): Promise<OrgScaffoldAdditionView> {
  const row = await db.query.orgScaffoldAdditions.findFirst({
    where: eq(orgScaffoldAdditions.id, id),
  });
  if (!row) throw new NotFoundError(`Scaffold addition ${id} not found`);
  return toView(row);
}

export async function createOrgScaffoldAddition(
  input: CreateOrgScaffoldAdditionInput,
  ctx: RequestCtx = {},
): Promise<Mutated<OrgScaffoldAdditionView>> {
  const { orgId, ...rest } = input;
  return createScaffoldAddition({ kind: "org", orgId }, rest, ctx);
}

export async function updateOrgScaffoldAddition(
  id: string,
  input: UpdateOrgScaffoldAdditionInput,
  ctx: RequestCtx = {},
): Promise<Mutated<OrgScaffoldAdditionView>> {
  return updateScaffoldAddition(id, input, ctx);
}

export async function toggleOrgScaffoldAddition(
  id: string,
  enabled: boolean,
  ctx: RequestCtx = {},
): Promise<Mutated<OrgScaffoldAdditionView>> {
  return toggleScaffoldAddition(id, enabled, ctx);
}

export async function deleteOrgScaffoldAddition(
  id: string,
  ctx: RequestCtx = {},
): Promise<Mutated<void>> {
  return deleteScaffoldAddition(id, ctx);
}

/**
 * spec-193 t-5: resolve the per-memex view of an Org's overlay blocks. Keeps
 * account-wide rows (memexId absent / NULL — the default for security and
 * house-style blocks) AND the rows scoped to THIS memex; drops rows scoped to a
 * DIFFERENT memex. Pure + total, so every consumer (the nudge getter and the
 * transition-rubric path) filters IDENTICALLY and a per-memex override can never
 * bleed into another memex's prompting. When `memexId` is undefined (a personal
 * namespace with no bound memex), only account-wide rows survive.
 *
 * The merge IS this filter: account-wide ∪ (this memex) — you can aggregate
 * account-wide items up, you cannot disaggregate a shared list back down per
 * memex (dec-6 rationale).
 */
export function filterOrgBlocksForMemex<T extends { memexId?: string }>(
  blocks: readonly T[],
  memexId: string | undefined,
): T[] {
  return blocks.filter((b) => b.memexId === undefined || b.memexId === memexId);
}
