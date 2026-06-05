// Per-call authorization helpers for the MCP endpoint. Centralises the "given this
// userId and a memex hint (`<namespace>/<memex>` slash form) or an entity reference
// (UUID), what memexId should this tool execute against, and is the user allowed?"
// logic.
//
// The MCP server is invoked with one user-scoped token; tools that need memex
// context call resolveWorkspace, tools that take an entity UUID call
// resolveMemexFromEntity. Both throw McpAuthError on miss/forbid; caller maps to a
// readable MCP error message.
//
// Per F.5 of doc-15: the `memex` argument is `<namespace>/<memex>` — parsing is a
// single split on '/'. A bare single token (no slash) is treated as a namespace and
// only resolves when the namespace contains exactly one memex (the common personal /
// single-memex-org case). A token with no matching namespace or with multiple memexes
// behind it errors with the available list.

import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  namespaces,
  memexes,
  orgs,
  documents,
  decisions,
  tasks,
  docSections,
  docComments,
  orgMemberships,
} from "../db/schema.js";
import { listMemberships } from "../services/users.js";

export class McpAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpAuthError";
  }
}

// spec-111 t-4: the single source of truth for the read-only rejection message.
// Surfaced to the agent when a non-member (readOnly === true) invokes a write
// tool on a public Memex. Kept as one exported constant so the dispatch wrapper
// (mcp/tools.ts) and tests assert against the identical string.
export const READ_ONLY_PUBLIC_MESSAGE =
  "Public Memexes are read-only for non-members";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

// Resolves a memex hint (`<namespace>/<memex>` slash form, bare namespace slug, or
// UUID) to a memexId after verifying the user is an active member.
//
// `orgFilter` (b-31 dec-8):
//   - `undefined` → PAT caller. No Org-scope filter applied. Existing
//     behaviour, no regression.
//   - `null` → OAuth caller authorised for personal-only. The resolved memex
//     MUST live in the user's personal namespace.
//   - `<orgId>` → OAuth caller authorised for one Org. The resolved memex
//     MUST live in either the user's personal namespace OR the given Org.
//
// Failures still throw McpAuthError with the SAME message as a regular
// membership miss (std-7, no info leak about why this specific memex was
// rejected).
export async function resolveWorkspace(
  userId: string,
  memexArg: string | undefined,
  orgFilter?: string | null,
): Promise<string> {
  const { memexId, slug } = await resolveWorkspaceId(userId, memexArg);
  await assertMembershipForMemex(userId, memexId, slug, orgFilter);
  return memexId;
}

// spec-111 t-4: read-gated workspace resolution. Mirrors resolveWorkspace's
// slug/UUID parsing but applies the LOOSER canReadMemex gate instead of the
// write-only assertMembershipForMemex, and reports back whether the caller has
// write access. The MCP dispatch wrapper stamps the returned `readOnly` flag
// into context and rejects write tools when it is set.
//
// `userId` may be null for a truly anonymous caller (t-3 anonymous session
// path). Anonymous callers can only pass the public branch of canReadMemex;
// private memexes surface the std-7 "not found" error, identical to a member
// miss, so existence is not leaked.
export async function resolveWorkspaceForRead(
  userId: string | null,
  memexArg: string | undefined,
  orgFilter?: string | null,
): Promise<{ memexId: string; readOnly: boolean }> {
  // The no-arg auto-pick path only makes sense for an authenticated caller —
  // it lists the user's memberships. Anonymous callers must name the memex.
  if (userId === null && !memexArg) {
    throw new McpAuthError(
      "You have no Memexes. Sign up or get invited to one first.",
    );
  }
  const { memexId, slug } = await resolveWorkspaceId(userId ?? "", memexArg);
  return assertReadAccessAndWriteFlag(userId, memexId, slug, orgFilter);
}

// Internal: the slug / UUID / no-arg parsing half of resolveWorkspace, WITHOUT
// any authorization. Both the write entrypoint (resolveWorkspace) and the read
// entrypoint (resolveWorkspaceForRead) layer their respective gate on top of
// the same identifier resolution so the two paths can never diverge in how a
// `<namespace>/<memex>` string maps to a memexId.
async function resolveWorkspaceId(
  userId: string,
  memexArg: string | undefined,
): Promise<{ memexId: string; slug?: string }> {
  if (!memexArg) {
    const memberships = await listMemberships(userId);
    if (memberships.length === 0) {
      throw new McpAuthError(
        "You have no Memexes. Sign up or get invited to one first.",
      );
    }
    if (memberships.length === 1) return { memexId: memberships[0].memexId };
    // dec-5 of doc-15: multi-namespace + no arg → error with list of available
    // identifiers in `<namespace>/<memex>` form (per F.5). Don't auto-pick
    // personal; the agent should confirm with the user.
    const ids = memberships
      .map((m) => `"${m.slug}/${m.memexSlug}"`)
      .join(", ");
    throw new McpAuthError(
      `Multiple Memexes available (${ids}); pass memex=<namespace>/<memex> to choose. Use list_memexes() to see details.`,
    );
  }

  let memex: { id: string; namespaceId: string } | undefined;
  let slug: string | undefined;

  if (isUuid(memexArg)) {
    const m = await db.query.memexes.findFirst({ where: eq(memexes.id, memexArg) });
    if (m) {
      memex = { id: m.id, namespaceId: m.namespaceId };
      const ns = await db.query.namespaces.findFirst({ where: eq(namespaces.id, m.namespaceId) });
      slug = ns?.slug;
    }
  } else {
    // F.5: parsing is a single split on '/'.
    // b-42 t-3 — bare-namespace form (no `/`) was previously auto-resolved when
    // the namespace contained exactly one memex. That shortcut is a time-bomb:
    // every prior caller breaks at once the moment a 2nd memex appears in the
    // namespace. Reject up-front so the caller is forced to use the explicit
    // slash form before that surprise can hit.
    const trimmed = memexArg.trim().toLowerCase();
    const slashIndex = trimmed.indexOf("/");
    if (slashIndex === -1) {
      throw new McpAuthError(
        `Memex argument "${memexArg}" must be in \`<namespace>/<memex>\` form (e.g. "mindset/website-rewrite"). Bare-namespace form is no longer accepted. Call list_memexes() to see available identifiers.`,
      );
    }
    const nsSlug = trimmed.slice(0, slashIndex);
    const mxSlug = trimmed.slice(slashIndex + 1);
    if (!nsSlug || !mxSlug || mxSlug.includes("/")) {
      throw new McpAuthError(
        `Invalid memex identifier "${memexArg}". Expected \`<namespace>/<memex>\` (e.g. "mindset/website-rewrite"). Call list_memexes() to see available identifiers.`,
      );
    }
    const ns = await db.query.namespaces.findFirst({
      where: eq(namespaces.slug, nsSlug),
    });
    if (!ns) {
      throw new McpAuthError(
        `Namespace "${nsSlug}" not found. Call list_memexes() to see available identifiers.`,
      );
    }
    slug = ns.slug;
    const m = await db.query.memexes.findFirst({
      where: (row, { and: andCond, eq: eqCond }) =>
        andCond(eqCond(row.namespaceId, ns.id), eqCond(row.slug, mxSlug)),
    });
    if (m) memex = { id: m.id, namespaceId: m.namespaceId };
  }

  if (!memex) {
    throw new McpAuthError(
      `Memex "${memexArg}" not found. Use \`<namespace>/<memex>\` form (e.g. "mindset/website-rewrite"). Call list_memexes() to see available identifiers.`,
    );
  }

  return { memexId: memex.id, slug };
}

// spec-111 t-4: shared read-gate + write-flag resolver. Used by every read
// entrypoint after it has resolved a memexId.
//
//   1. canReadMemex decides VISIBILITY. Public memexes are readable by anyone
//      (incl. anonymous userId === null); private memexes fall back to the
//      membership check. A read miss throws the SAME std-7 "not found"-style
//      error as a write miss so "private" and "nonexistent" are indistinguishable.
//   2. canWriteMemex decides MUTABILITY. `readOnly` is its negation — true for a
//      non-member reading a public memex (incl. anonymous), false for a member.
// spec-111 t-4: public wrapper for callers that already hold a memexId (e.g.
// the ref-resolution path in mcp/tools.ts). Applies the read gate and returns
// the `readOnly` write flag; throws the std-7 error on a read miss.
export async function assertReadAccessForMemex(
  userId: string | null,
  memexId: string,
  slugForError?: string,
  orgFilter?: string | null,
): Promise<{ readOnly: boolean }> {
  const { readOnly } = await assertReadAccessAndWriteFlag(
    userId,
    memexId,
    slugForError,
    orgFilter,
  );
  return { readOnly };
}

async function assertReadAccessAndWriteFlag(
  userId: string | null,
  memexId: string,
  slugForError?: string,
  orgFilter?: string | null,
): Promise<{ memexId: string; readOnly: boolean }> {
  const canRead = await canReadMemex(userId, memexId, slugForError, orgFilter);
  if (!canRead) {
    // std-7: a non-member hitting a private memex must be indistinguishable
    // from one that does not exist. Reuse the membership-miss message.
    const label = slugForError ? `"${slugForError}"` : `"${memexId}"`;
    throw new McpAuthError(
      `You are not a member of Memex ${label}. Use list_memexes() to see your Memexes.`,
    );
  }
  // Anonymous callers can never write. For authenticated callers, write access
  // is the existing membership predicate.
  const canWrite =
    userId === null
      ? false
      : await canWriteMemex(userId, memexId, slugForError, orgFilter);
  return { memexId, readOnly: !canWrite };
}

// Loads a memex + its parent namespace, or throws the std-7-compliant "not
// found" error. Shared by every gate below so "doesn't exist" and "exists but
// you can't see it" stay indistinguishable.
async function loadMemexAndNamespace(
  memexId: string,
  slugForError?: string,
): Promise<{
  memex: { id: string; namespaceId: string; visibility: string };
  ns: { kind: string; ownerUserId: string | null; ownerOrgId: string | null };
}> {
  const memex = await db.query.memexes.findFirst({ where: eq(memexes.id, memexId) });
  if (!memex) {
    const label = slugForError ? `"${slugForError}"` : `"${memexId}"`;
    throw new McpAuthError(`Memex ${label} not found.`);
  }
  const ns = await db.query.namespaces.findFirst({ where: eq(namespaces.id, memex.namespaceId) });
  if (!ns) {
    throw new McpAuthError(`Memex namespace not found.`);
  }
  return {
    memex: { id: memex.id, namespaceId: memex.namespaceId, visibility: memex.visibility },
    ns: { kind: ns.kind, ownerUserId: ns.ownerUserId, ownerOrgId: ns.ownerOrgId },
  };
}

// True membership predicate: does this user have WRITE access to the memex?
// Personal memexes are gated on ownership of the parent namespace; org memexes
// on an active org_membership row. This is the EXACT semantics that
// `assertMembershipForMemex` enforced before spec-111 — preserved verbatim so
// every existing caller keeps the same behaviour.
//
// `orgFilter` (b-31 dec-8) extends membership with an OAuth-grant constraint;
// see resolveWorkspace for semantics. PAT callers pass `undefined` and keep
// the legacy behaviour. Returns false on any denial (no throw) — callers that
// want the std-7 error use `assertMembershipForMemex`.
export async function canWriteMemex(
  userId: string,
  memexId: string,
  slugForError?: string,
  orgFilter?: string | null,
): Promise<boolean> {
  const { ns } = await loadMemexAndNamespace(memexId, slugForError);

  // Membership check (unchanged shape).
  const isPersonal = ns.kind === "user" && ns.ownerUserId === userId;
  let isOrgMember = false;
  if (ns.kind === "org" && ns.ownerOrgId) {
    const m = await db.query.orgMemberships.findFirst({
      where: (row, { eq, and }) =>
        and(eq(row.userId, userId), eq(row.orgId, ns.ownerOrgId!), eq(row.status, "active")),
    });
    isOrgMember = !!m;
  }

  if (!isPersonal && !isOrgMember) return false;

  // OAuth Org-scope filter — applied AFTER membership confirms access exists.
  // We treat a scope miss identically to a membership miss so an OAuth caller
  // can't distinguish "not a member" from "not within my token's Org scope".
  if (orgFilter !== undefined) {
    if (isPersonal) return true; // personal always granted
    if (orgFilter === null) return false; // personal-only token, this is an org memex
    if (ns.ownerOrgId !== orgFilter) return false;
  }

  return true;
}

// READ predicate (spec-111). Public memexes are readable by everyone INCLUDING
// anonymous callers (userId === null); private memexes fall back to the
// write/membership gate. The org is resolved via memexes.namespaceId →
// namespaces.ownerOrgId inside canWriteMemex.
//
// Anonymous callers (userId null) can only ever pass the public branch — they
// have no membership, so private memexes are not readable.
export async function canReadMemex(
  userId: string | null,
  memexId: string,
  slugForError?: string,
  orgFilter?: string | null,
): Promise<boolean> {
  const { memex } = await loadMemexAndNamespace(memexId, slugForError);
  if (memex.visibility === "public") return true;
  if (userId === null) return false;
  return canWriteMemex(userId, memexId, slugForError, orgFilter);
}

// Confirms the user has WRITE access to the given memex, throwing the
// std-7-compliant McpAuthError on denial (mapped to a 404 by the caller so
// "doesn't exist" and "exists but private" are indistinguishable). Thin
// throwing wrapper over `canWriteMemex` — preserves the pre-spec-111 contract
// for every existing caller.
export async function assertMembershipForMemex(
  userId: string,
  memexId: string,
  slugForError?: string,
  orgFilter?: string | null,
): Promise<void> {
  // loadMemexAndNamespace throws the "not found" error if the memex is gone,
  // matching the previous behaviour before we check membership.
  await loadMemexAndNamespace(memexId, slugForError);

  const allowed = await canWriteMemex(userId, memexId, slugForError, orgFilter);
  if (!allowed) {
    const label = slugForError ? `"${slugForError}"` : `"${memexId}"`;
    throw new McpAuthError(
      `You are not a member of Memex ${label}. Use list_memexes() to see your Memexes.`,
    );
  }
}

// Back-compat alias for callers that haven't been renamed yet.
export const assertMembership = assertMembershipForMemex;

// Resolves the memexId for a given entity reference and verifies membership.
// `orgFilter` (b-31 dec-8) — see resolveWorkspace.
export async function resolveMemexFromEntity(
  userId: string,
  kind: "doc" | "section" | "decision" | "task" | "comment",
  id: string,
  orgFilter?: string | null,
): Promise<string> {
  const memexId = await lookupMemexIdForEntity(kind, id);
  await assertMembershipForMemex(userId, memexId, undefined, orgFilter);
  return memexId;
}

// spec-111 t-4: read-gated entity resolution. Same FK walk as
// resolveMemexFromEntity, but applies canReadMemex and reports `readOnly` so
// the dispatch wrapper can gate write tools. See resolveWorkspaceForRead.
export async function resolveMemexFromEntityForRead(
  userId: string | null,
  kind: "doc" | "section" | "decision" | "task" | "comment",
  id: string,
  orgFilter?: string | null,
): Promise<{ memexId: string; readOnly: boolean }> {
  const memexId = await lookupMemexIdForEntity(kind, id);
  return assertReadAccessAndWriteFlag(userId, memexId, undefined, orgFilter);
}

// Internal: walk an entity UUID to its owning memexId without authorization.
async function lookupMemexIdForEntity(
  kind: "doc" | "section" | "decision" | "task" | "comment",
  id: string,
): Promise<string> {
  if (!isUuid(id)) {
    throw new McpAuthError(
      `${kind}Id must be a UUID. If you have a handle (e.g. "doc-1", "dec-2"), pass memex=<namespace>/<memex> instead and use list_docs / get_doc to look up the UUID.`,
    );
  }

  let memexId: string | undefined;

  switch (kind) {
    case "doc": {
      const row = await db.query.documents.findFirst({
        where: eq(documents.id, id),
        columns: { memexId: true },
      });
      memexId = row?.memexId;
      break;
    }
    case "section": {
      const row = await db
        .select({ memexId: documents.memexId })
        .from(docSections)
        .innerJoin(documents, eq(docSections.docId, documents.id))
        .where(eq(docSections.id, id))
        .limit(1);
      memexId = row[0]?.memexId;
      break;
    }
    case "decision": {
      const row = await db.query.decisions.findFirst({
        where: eq(decisions.id, id),
        columns: { memexId: true },
      });
      memexId = row?.memexId;
      break;
    }
    case "task": {
      const row = await db.query.tasks.findFirst({
        where: eq(tasks.id, id),
        columns: { memexId: true },
      });
      memexId = row?.memexId;
      break;
    }
    case "comment": {
      const row = await db.query.docComments.findFirst({
        where: eq(docComments.id, id),
        columns: { memexId: true },
      });
      memexId = row?.memexId;
      break;
    }
  }

  if (!memexId) {
    throw new McpAuthError(`${kind} "${id}" not found.`);
  }

  return memexId;
}

// One-call helper for tools that accept either `entityId` (UUID, infer the Memex
// from the FK) or `memex` + a handle. Returns the resolved memexId.
// `orgFilter` (b-31 dec-8) — see resolveWorkspace.
export async function resolveMemexFromDocRef(
  userId: string,
  docIdOrHandle: string,
  memexArg: string | undefined,
  orgFilter?: string | null,
): Promise<string> {
  if (isUuid(docIdOrHandle)) {
    return resolveMemexFromEntity(userId, "doc", docIdOrHandle, orgFilter);
  }
  if (!memexArg) {
    throw new McpAuthError(
      `"${docIdOrHandle}" looks like a handle. Pass memex=<namespace>/<memex> so the right doc can be found, or pass a UUID instead.`,
    );
  }
  return resolveWorkspace(userId, memexArg, orgFilter);
}

// Suppress unused import warning — orgMemberships is referenced via the relational
// query builder helper above (`db.query.orgMemberships`).
void orgs;
void orgMemberships;
