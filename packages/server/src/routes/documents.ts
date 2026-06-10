import { Hono } from "hono";
import { listDocs, getDoc, updateDocStatus, updateDocTitle, archiveDoc, pauseDoc, unpauseDoc } from "../services/documents.js";
import { restCtx } from "./_actor-ctx.js";
import { moveDoc, ForbiddenError } from "../services/doc-move.js";
import { splitSection, updateSection } from "../services/sections.js";
import { listDecisions } from "../services/decisions.js";
import { listTasks } from "../services/tasks.js";
import {
  listDocTags,
  listMemexTags,
  listDocTagsForDocs,
  applyTagStrings,
  removeTagFromDoc,
  parseTagInput,
  type ParsedTag,
} from "../services/tags.js";
import { ValidationError } from "../types/errors.js";
import {
  createShareToken,
  listShareTokensForDoc,
  revokeShareToken,
} from "../services/share-tokens.js";
import {
  sessionMiddleware,
  publicSessionMiddleware,
  type SessionEnv,
} from "../middleware/session.js";
import type { MemexResolverEnv } from "../middleware/memex-resolver.js";
import type { User } from "../db/schema.js";
import { requireMemexId, resolveReadableMemexId } from "./shared.js";
import { bus } from "../services/bus.js";
import { sessionIdFromAuthHeader } from "../services/auth-jwt.js";

type Env = MemexResolverEnv & SessionEnv;
const docs = new Hono<Env>();

// ── Pulse (b-60) read-activity emission ───────────────────────────────────────
//
// `viewed` events for human Spec/Standard/free-doc reads are emitted from a
// single site (`emitViewed`) invoked by the GET read handlers below. The emit is
// strictly advisory: it never throws, never blocks the response, and is a no-op
// on any failure. The handler returns its normal payload regardless.

// In-memory throttle: at most one `viewed` event per (user, doc, 60s) window.
// Opening a Spec and flipping between its tabs within a minute is one event, not
// a storm. A bare Map is fine — Pulse activity is best-effort and process-local;
// a restart simply re-arms the window. Entries are pruned lazily on access.
const VIEWED_THROTTLE_MS = 60_000;
const lastViewedAt = new Map<string, number>();

function shouldEmitViewed(userId: string, docId: string, now: number): boolean {
  const key = `${userId}:${docId}`;
  const prev = lastViewedAt.get(key);
  if (prev !== undefined && now - prev < VIEWED_THROTTLE_MS) return false;
  lastViewedAt.set(key, now);
  // Opportunistic prune so the Map can't grow unbounded across long-lived
  // processes — drop windows that have fully elapsed.
  if (lastViewedAt.size > 1024) {
    for (const [k, t] of lastViewedAt) {
      if (now - t >= VIEWED_THROTTLE_MS) lastViewedAt.delete(k);
    }
  }
  return true;
}

// Compose a human-readable one-liner from the doc handle. The handle prefix
// encodes the doc kind (`spec-N` Spec, `std-N` Standard, `doc-N` free-doc) so we
// can read naturally without a second lookup: "viewing spec-31", "reading std-9 §2".
function composeViewedNarrative(handle: string, section: string | undefined): string {
  const isStandard = handle.startsWith("std-");
  const verb = isStandard ? "reading" : "viewing";
  const tail = section ? ` §${section}` : "";
  return `${verb} ${handle}${tail}`;
}

// Single emit site. Synchronous, wrapped in try/catch, swallows everything. The
// bus dispatch is in-process and cheap; even so we keep this off the response's
// critical fields — it runs after the response body is already composed.
function emitViewed(args: {
  userId: string;
  memexId: string;
  docId: string;
  handle: string;
  clientId: string | null;
  section: string | undefined;
  query: string | undefined;
}): void {
  try {
    if (!shouldEmitViewed(args.userId, args.docId, Date.now())) return;
    const payload: Record<string, unknown> = {};
    if (args.section) payload.section = args.section;
    if (args.query) payload.query = args.query;
    bus.emit({
      memexId: args.memexId,
      docId: args.docId,
      userId: args.userId,
      entity: "document",
      action: "viewed",
      channel: "rest_ui",
      clientId: args.clientId ?? undefined,
      narrative: composeViewedNarrative(args.handle, args.section),
      payload: Object.keys(payload).length > 0 ? payload : undefined,
    });
  } catch {
    // Advisory only — a failed Pulse emit must never affect the read response.
  }
}

// spec-111 t-10 — PER-VERB session policy. Reads (GET) go behind the PERMISSIVE
// publicSessionMiddleware so anonymous/non-member callers reach the handler with
// currentUserId possibly null; each GET handler then gates the path memex via
// resolveReadableMemexId (public → read, private → 404 per std-7). Every
// mutating verb stays on the STRICT sessionMiddleware (401 anonymous, 404
// non-member) so a write can never be reached without membership.
//
// NOTE: the share-token management writes (POST /:docId/share, DELETE
// /shares/:shareId) and the GET /:docId/shares listing all fall under these
// verb buckets — share writes via the strict POST/DELETE stack, the shares GET
// via the permissive read stack but still requiring a readable memex.
docs.on("GET", "/*", publicSessionMiddleware);
docs.on(["POST", "PUT", "PATCH", "DELETE"], "/*", sessionMiddleware);

// spec-136 t-4: collect tag filter strings from the `?tags=` query param. Accepts
// either repeated params (?tags=a&tags=b) or CSV (?tags=a,b) — both flatten to one
// list. Each string is parsed into a {scope, value} ParsedTag via the shared
// parseTagInput (validates + splits on the first `::`); an empty/whitespace entry
// throws ValidationError → 400 at the boundary rather than silently filtering wrong.
function parseTagFilter(raw: string[] | undefined): ParsedTag[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  const strings = raw
    .flatMap((s) => s.split(","))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (strings.length === 0) return undefined;
  return strings.map(parseTagInput);
}

docs.get("/", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  const docType = c.req.query("type");
  // ?include=<token>[,<token>...] — comma-separated set. Known tokens are
  // `driftCount` (t-19 W2), `acHealth` (b-66 t-2), `assignees` (spec-118 ac-18),
  // and `tags` (spec-136 t-4). Unknown tokens are ignored so callers can pass
  // extras forward-compatibly without 400s.
  const includeRaw = c.req.query("include");
  const includes = (includeRaw ?? "")
    .split(",")
    .map((s) => s.trim());
  const includeDriftCount = includes.includes("driftCount");
  const includeAcHealth = includes.includes("acHealth");
  const includeAssignees = includes.includes("assignees");
  const includeTags = includes.includes("tags");
  // spec-136 t-4: optional tag facet filter (repeated or CSV `?tags=`). Additive to
  // docType — the Specs view keeps passing its own docType, so it stays the source of
  // truth for what counts as a Spec. listDocs runs the indexed (scope,value) join.
  const tagFilter = parseTagFilter(c.req.queries("tags"));
  const result = await listDocs(memexId, {
    docType: docType || undefined,
    includeDriftCount,
    includeAcHealth,
    includeAssignees,
    ...(tagFilter ? { tags: tagFilter } : {}),
  });

  // spec-136 t-4: when ?include=tags is requested, attach each doc's tags in ONE
  // batch round-trip (mirrors includeAssignees) so the React cards render tags
  // without an N+1 fan-out. Omitted otherwise so callers that don't ask aren't
  // paying for the join.
  if (includeTags && result.length > 0) {
    const tagsByDoc = await listDocTagsForDocs(
      memexId,
      result.map((d) => d.id),
    );
    const withTags = result.map((d) => ({ ...d, tags: tagsByDoc.get(d.id) ?? [] }));
    return c.json(withTags);
  }
  return c.json(result);
});

// spec-136 t-4: the Memex's whole tag catalogue, for the picker type-ahead.
// Registered BEFORE `/:id` so the literal `/tags` segment isn't swallowed by the
// param route. Returns every `{scope, value}` coined in this Memex so the UI can
// offer existing tags before the user mints a near-duplicate.
docs.get("/tags", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  const all = await listMemexTags(memexId);
  return c.json(all);
});

// std-5 exemption: when this route is hit at the flat `/api/docs/:id` (UUID),
// the memex is determined by the entity FK, not the caller's membership set.
// `requireMemexId` returns the currentMemexId resolved by sessionMiddleware —
// either from the path prefix (/api/<ns>/<mx>/docs/:id) or from a single
// membership; multi-membership callers must use the path-prefixed form.
docs.get("/:id", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  const id = c.req.param("id");
  const result = await getDoc(memexId, id);
  const decs = await listDecisions(memexId, result.id);
  const tasks = await listTasks(memexId, result.id);

  // Pulse (b-60). Emit a `viewed` activity event for this human read. Advisory,
  // throttled per (user, doc, 60s), and a no-op on failure — emitViewed swallows
  // everything so the read response below is unaffected.
  //
  // spec-111 t-10: on the permissive read path an anonymous reader has NO `user`
  // (publicSessionMiddleware leaves it unset). Skip the Pulse emit entirely for
  // anonymous reads — there's no actor to attribute the `viewed` event to, and
  // the throttle map is keyed by userId.
  const user = c.get("user") as User | undefined;
  if (user) {
    emitViewed({
      userId: user.id,
      memexId,
      docId: result.id,
      handle: result.handle,
      clientId: sessionIdFromAuthHeader(c.req.header("Authorization")),
      section: c.req.query("section"),
      query: c.req.query("query"),
    });
  }

  // spec-136 t-4: include the doc's tags so the React doc view renders them inline.
  const docTags = await listDocTags(memexId, result.id);
  return c.json({ ...result, decisions: decs, tasks, tags: docTags });
});

docs.post("/:id/status", async (c) => {
  const memexId = requireMemexId(c);
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => null)) as { status?: unknown } | null;
  const status = body?.status;
  if (typeof status !== "string") {
    throw new ValidationError("Body must include a 'status' string");
  }
  // spec-122 dec-3 — carry the actor/channel onto the status_changed journal row.
  const updated = await updateDocStatus(memexId, id, status, { source: "rest", ctx: restCtx(c) });
  return c.json(updated);
});

docs.post("/:id/archive", async (c) => {
  const memexId = requireMemexId(c);
  const id = c.req.param("id");
  const updated = await archiveDoc(memexId, id);
  return c.json(updated);
});

docs.post("/:id/pause", async (c) => {
  const memexId = requireMemexId(c);
  const id = c.req.param("id");
  const updated = await pauseDoc(memexId, id);
  return c.json(updated);
});

docs.post("/:id/unpause", async (c) => {
  const memexId = requireMemexId(c);
  const id = c.req.param("id");
  const updated = await unpauseDoc(memexId, id);
  return c.json(updated);
});

docs.post("/:id/move", async (c) => {
  const memexId = requireMemexId(c);
  const user = c.get("user");
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => null)) as {
    targetMemexId?: unknown;
    includeDecisions?: unknown;
    includeTasks?: unknown;
    includeSectionComments?: unknown;
  } | null;

  const targetMemexId = body?.targetMemexId;
  if (typeof targetMemexId !== "string" || targetMemexId.length === 0) {
    throw new ValidationError("Body must include a 'targetMemexId' string");
  }

  try {
    const result = await moveDoc(memexId, id, targetMemexId, user.id, {
      includeDecisions: Boolean(body?.includeDecisions),
      includeTasks: Boolean(body?.includeTasks),
      includeSectionComments: Boolean(body?.includeSectionComments),
    });
    return c.json(result);
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return c.json({ error: "Forbidden", message: err.message }, 403);
    }
    throw err;
  }
});

docs.post("/:id/title", async (c) => {
  const memexId = requireMemexId(c);
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => null)) as { title?: unknown } | null;
  const title = body?.title;
  if (typeof title !== "string") {
    throw new ValidationError("Body must include a 'title' string");
  }
  const updated = await updateDocTitle(memexId, id, title);
  return c.json(updated);
});

// ── Tags (spec-136 t-4) ──────────────────────────────────────
// The React tag picker calls these to add/remove tags on a Spec. Writes route
// through the tags service (applyTagStrings / removeTagFromDoc) — never raw inserts —
// so create-or-pick, per-scope mutual exclusivity, and the change-bus emission all
// happen in one place. Attribution: the link's `added_by` is the session user
// (c.get('currentUserId'), mirroring routes/doc-assignees.ts); the bus event's
// rest_ui channel records the actor *kind* (human) for activity_log (spec-122).

// POST /api/docs/:id/tags — apply one or more tags to the Spec. Body: { tags: string[] }
// where each entry is a `scope::value` or flat string. Returns the Spec's full tag set
// after the writes so the picker can re-render without a follow-up GET.
docs.post("/:id/tags", async (c) => {
  const memexId = requireMemexId(c);
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => null)) as { tags?: unknown } | null;
  const rawTags = body?.tags;
  if (!Array.isArray(rawTags) || rawTags.some((t) => typeof t !== "string")) {
    throw new ValidationError("Body must include a 'tags' array of strings");
  }
  const addedBy = (c.get("currentUserId") as string | null) ?? null;
  const applied = await applyTagStrings(
    { channel: "rest_ui" },
    memexId,
    id,
    rawTags as string[],
    addedBy,
  );
  const docTags = await listDocTags(memexId, id);
  return c.json({ applied, tags: docTags });
});

// POST /api/docs/:id/tags/remove — drop a single tag link from the Spec. Body: { tagId }.
// Returns the Spec's remaining tag set. Removing a tag the Spec doesn't carry is a no-op.
docs.post("/:id/tags/remove", async (c) => {
  const memexId = requireMemexId(c);
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => null)) as { tagId?: unknown } | null;
  const tagId = body?.tagId;
  if (typeof tagId !== "string" || tagId.length === 0) {
    throw new ValidationError("Body must include a 'tagId' string");
  }
  await removeTagFromDoc({ channel: "rest_ui" }, memexId, id, tagId);
  const docTags = await listDocTags(memexId, id);
  return c.json({ tags: docTags });
});

// std-5 exemption: section-UUID lookup. The memex is derived from the section's
// parent doc FK, not the caller's membership set. Flat path stays functional
// for entity-keyed access.
docs.post("/sections/:sectionId/split", async (c) => {
  const memexId = requireMemexId(c);
  const sectionId = c.req.param("sectionId");
  const sections = await splitSection(memexId, sectionId);
  return c.json(sections);
});

// POST /docs/sections/:sectionId — update a section's content. The MCP
// `update_section` tool exposes the same surface; this REST mirror gives SPA
// clients (and the doc-16 reactivity e2e journeys) a uniform write path.
docs.post("/sections/:sectionId", async (c) => {
  const memexId = requireMemexId(c);
  const sectionId = c.req.param("sectionId");
  const body = await c.req.json().catch(() => ({}));
  const content = body?.content;
  if (typeof content !== "string") {
    throw new ValidationError("Body must include a 'content' string");
  }
  const updated = await updateSection(memexId, sectionId, content, {}, restCtx(c));
  return c.json(updated);
});

// ── Share link management (t-10) ─────────────────────────────
// Authenticated endpoints — any member can create/list/revoke share tokens for their doc.

// POST /api/docs/:docId/share — generate a new share token
docs.post("/:docId/share", async (c) => {
  const memexId = requireMemexId(c);
  const docId = c.req.param("docId");
  const createdByUserId = (c.get("currentUserId") as string | null) ?? null;
  const share = await createShareToken(memexId, docId, createdByUserId);
  return c.json(share, 201);
});

// GET /api/docs/:docId/shares — list active share tokens for the doc.
//
// spec-111 t-10: this GET sits in the permissive read bucket, but its payload is
// SECRET (the share-token strings themselves). It must stay MEMBER-ONLY — a
// public-memex visitor must NOT be able to enumerate share links. We gate on
// membership (`currentMemexId` set by the session middleware only when the
// caller is a member) rather than the looser canReadMemex. A non-member/anonymous
// caller has no currentMemexId → std-7 404 (indistinguishable from non-existent).
docs.get("/:docId/shares", async (c) => {
  const memexId = c.get("currentMemexId");
  if (!memexId) {
    // Not a member of the resolved memex (or no memex context) — 404, not a leak.
    return c.json({ error: "Not found" }, 404);
  }
  const docId = c.req.param("docId");
  const list = await listShareTokensForDoc(memexId, docId);
  return c.json(list);
});

// DELETE /api/docs/shares/:shareId — revoke a share token (soft-delete via revoked=true)
// std-5 exemption: share-token UUID lookup. Memex is determined by the share-
// token entity's FK to the parent document.
docs.delete("/shares/:shareId", async (c) => {
  const memexId = requireMemexId(c);
  const shareId = c.req.param("shareId");
  const revoked = await revokeShareToken(memexId, shareId);
  return c.json(revoked);
});

export { docs };
