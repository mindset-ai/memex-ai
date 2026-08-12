import { Hono } from "hono";
import { listDocs, getDoc, updateDocStatus, updateDocTitle, archiveDoc, restoreDoc } from "../services/documents.js";
import { restCtx } from "./_actor-ctx.js";
import { moveDoc } from "../services/doc-move.js";
import { splitSection, updateSection } from "../services/sections.js";
import { listDecisions } from "../services/decisions.js";
import { listTasks } from "../services/tasks.js";
// spec-423 t-8 (dec-7) — project each task/decision's cast facet keys so the doc view
// renders them as pills.
import { facetKeysByTask, facetKeysByDecision } from "../services/facet-ballot.js";
import {
  listDocTags,
  listMemexTags,
  listMemexTagsWithCounts,
  listDocTagsForDocs,
  applyTagStrings,
  removeTagFromDoc,
  parseTagInput,
  createTag,
  renameTag,
  deleteTag,
  type ParsedTag,
} from "../services/tags.js";
import {
  parseJsonBodyOrNull,
  requireString,
  requireStringType,
  requireStringArray,
} from "./validation.js";
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
// spec-448 t-5: per-user "last-seen version" marker + catch-up payload.
import { upsertDocView, computeCatchUp } from "../services/docViews.js";

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

// spec-529 (ac-10): `?handles=spec-1,spec-2` — repeated params or CSV, flattened to
// one list, mirroring parseTagFilter. Every entry is checked against the handle
// grammar [per std-10 cl-4..cl-12]: type prefix mandatory, case-strict, positive
// integer with no leading zeros. A malformed entry is DROPPED rather than 400-ing —
// the caller here is a rendered document body, not a hand-written API call, and one
// odd string in prose must not fail the whole page's resolution. Dropping it also
// keeps a non-existent handle and an unreadable one indistinguishable [per std-7].
const HANDLE_FILTER_GRAMMAR = /^(?:spec|doc|std)-[1-9][0-9]*$/;

function parseHandleFilter(raw: string[] | undefined): string[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  const handles = raw
    .flatMap((s) => s.split(","))
    .map((s) => s.trim())
    .filter((s) => HANDLE_FILTER_GRAMMAR.test(s));
  // An explicit `?handles=` that survives to nothing still means "these Specs" —
  // listDocs filters to the empty set rather than falling back to the whole Memex.
  return [...new Set(handles)];
}

// spec-418 t-3: the curation write routes (create / rename) accept EITHER a
// `scope::value`/flat tag STRING (the `tag` field, parsed with the shared
// parseTagInput so the boundary matches the picker's conventions) OR an already
// structured { scope, value } body — whichever the admin surface finds convenient.
// Returns the {scope, value} pair; the tags service (createTag / renameTag) runs
// validateTagInput on it, so trimming / empty-value / control-char rejection and
// the ValidationError→400 mapping stay in ONE place, not duplicated here.
function parseCurationTagBody(
  body: { tag?: unknown; scope?: unknown; value?: unknown } | null,
): { scope: string | null; value: string } {
  // Structured form wins when a `value` is present (a bare `scope` with no value
  // is meaningless — a tag must name something).
  if (typeof body?.value === "string") {
    const scope = typeof body.scope === "string" ? body.scope : null;
    return { scope, value: body.value };
  }
  const tag = requireString(body?.tag, "tag", {
    message: "Body must include a 'tag' string or a { scope, value } pair",
  });
  return parseTagInput(tag);
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
  // spec-529 (ac-10): `taskProgress` is the pill's `4/8 tasks`. It rides the same
  // opt-in `?include=` convention as acHealth so a caller that doesn't ask doesn't
  // pay for the aggregation.
  const includeTaskProgress = includes.includes("taskProgress");
  // spec-529 (ac-10, ac-11): `?handles=spec-1,spec-2` — resolve exactly the Specs a
  // document body mentions, in ONE request. Deliberately a filter on the EXISTING
  // list route rather than a new endpoint (dec-2): the board card, the reference pill
  // and any future consumer then read one server-side description of a Spec's status
  // and cannot drift into reporting different numbers for the same Spec. The cap
  // lives in listDocs, where the query is built.
  const handleFilter = parseHandleFilter(c.req.queries("handles"));
  // spec-136 t-4: optional tag facet filter (repeated or CSV `?tags=`). Additive to
  // docType — the Specs view keeps passing its own docType, so it stays the source of
  // truth for what counts as a Spec. listDocs runs the indexed (scope,value) join.
  const tagFilter = parseTagFilter(c.req.queries("tags"));
  // spec-521 (ac-5): `?includeArchived=true` powers the archive view — the one place
  // in the app that deliberately wants archived Specs. The board never passes it, so
  // it keeps hiding them unconditionally. This is a WEB read path and does NOT go
  // through the canonical resolver, so the dec-1 agent guard does not apply to it —
  // that separation is exactly why the guard needed no opt-in parameter (ac-11).
  const includeArchived = c.req.query("includeArchived") === "true";
  const result = await listDocs(memexId, {
    docType: docType || undefined,
    includeDriftCount,
    includeAcHealth,
    includeAssignees,
    includeArchived,
    includeTaskProgress,
    ...(tagFilter ? { tags: tagFilter } : {}),
    ...(handleFilter ? { handles: handleFilter } : {}),
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

// spec-418 t-5: the tag catalogue WITH each tag's assigned-Spec count, for the
// Manage-tags admin surface. Registered as a LITERAL before `/:id` (like GET /tags)
// so the segment isn't swallowed by the param matcher. Returns Array<Tag &
// {assignedCount}> from ONE aggregate query [per std-39 / ac-18] — never N per-tag
// counts. Reads use the permissive path (resolveReadableMemexId); org membership
// alone grants access [per std-4], with no administrator gate on the surface.
docs.get("/tags/with-counts", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  const all = await listMemexTagsWithCounts(memexId);
  return c.json(all);
});

// ── Tag catalogue curation (spec-418 t-3): create / rename / delete a tag ──────
// These three WRITES manage the Memex's tag CATALOGUE itself (the `tags` rows),
// distinct from POST /:id/tags below which attaches an existing/new tag to one
// Spec. Each calls the tags-service curation function (createTag / renameTag /
// deleteTag) — NEVER a raw insert/update/delete — so the duplicate + per-scope
// exclusivity guards, the fan-out of one `document` updated event per carrying
// Spec, and the change-bus emission (std-8) all live in one place.
//
// Registered BEFORE the `/:id` param routes so the literal `/tags` segment is not
// swallowed by the param matcher (the same reason GET /tags sits above GET /:id).
//
// AUTH — there is intentionally NO per-route auth check here. Every mutating verb
// on this router already runs behind the STRICT sessionMiddleware via the
// verb-bucket registration above (docs.on(["POST","PUT","PATCH","DELETE"], "/*",
// sessionMiddleware)); a non-member is rejected inside establishUserSession before
// the handler is reached. [per std-4] org membership alone grants access to every
// Memex in the org — the curation surface has NO administrator-role gate.
// [per std-7] an unauthorized caller receives 404 (indistinguishable from
// not-found), never 403. Service-raised errors map through the global handler:
// ValidationError→400 (a blocked create/rename surfaces the plain reason),
// NotFoundError→404 (a tag not in this Memex).
//
// Attribution: restCtx(c) carries the authenticated user + `rest_ui` channel onto
// every emitted event (std-32), so the tag/document activity is attributed to WHO
// curated it — not left unattributed.

// POST /api/docs/tags — mint a NEW catalogue tag. Body: { tag: "scope::value" }
// (or flat) OR { scope, value }. 201 with the created tag; 400 (plain reason) when
// a tag with that (scope, value) already exists — createTag blocks duplicates.
docs.post("/tags", async (c) => {
  const memexId = requireMemexId(c);
  const body = await parseJsonBodyOrNull<{ tag?: unknown; scope?: unknown; value?: unknown }>(c);
  const { scope, value } = parseCurationTagBody(body);
  const created = await createTag(restCtx(c), memexId, scope, value);
  return c.json(created, 201);
});

// PATCH /api/docs/tags/:tagId — rename a catalogue tag's (scope, value). Body: the
// new tag string / { scope, value }. The new name is reflected on EVERY Spec that
// carried the tag (a single set-based UPDATE). 400 (plain reason, NO change) when
// the rename would duplicate an existing tag OR leave a Spec holding two values in
// one scope; 404 when the tag isn't in this Memex.
docs.patch("/tags/:tagId", async (c) => {
  const memexId = requireMemexId(c);
  const tagId = c.req.param("tagId");
  const body = await parseJsonBodyOrNull<{ tag?: unknown; scope?: unknown; value?: unknown }>(c);
  const { scope, value } = parseCurationTagBody(body);
  const updated = await renameTag(restCtx(c), memexId, tagId, scope, value);
  return c.json(updated);
});

// DELETE /api/docs/tags/:tagId — delete a catalogue tag; the FK cascade removes it
// from every Spec that carried it, leaving those Specs otherwise untouched. Never
// blocks; 404 when the tag isn't in this Memex. Returns the blast radius
// ({ removed, affectedDocIds }) for the t-6 confirmation copy.
docs.delete("/tags/:tagId", async (c) => {
  const memexId = requireMemexId(c);
  const tagId = c.req.param("tagId");
  const result = await deleteTag(restCtx(c), memexId, tagId);
  return c.json(result);
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

  // spec-423 t-8 (dec-7) — attach each task/decision's cast facet keys for the pills.
  // Tasks/decisions with no ballot get [] (the empty-vocab + not-yet-balloted case).
  const taskFacets = await facetKeysByTask(memexId, tasks.map((t) => t.id));
  const decisionFacets = await facetKeysByDecision(memexId, decs.map((d) => d.id));
  const tasksWithFacets = tasks.map((t) => ({ ...t, facetKeys: taskFacets.get(t.id) ?? [] }));
  const decsWithFacets = decs.map((d) => ({ ...d, facetKeys: decisionFacets.get(d.id) ?? [] }));

  // Pulse (b-60). Emit a `viewed` activity event for this human read. Advisory,
  // throttled per (user, doc, 60s), and a no-op on failure — emitViewed swallows
  // everything so the read response below is unaffected.
  //
  // spec-111 t-10: on the permissive read path an anonymous reader has NO `user`
  // (publicSessionMiddleware leaves it unset). Skip the Pulse emit entirely for
  // anonymous reads — there's no actor to attribute the `viewed` event to, and
  // the throttle map is keyed by userId.
  const user = c.get("user") as User | undefined;

  // spec-448 t-5 (ac-39): compute the viewer's catch-up state BEFORE stamping
  // below advances their marker — stamping sets last_viewed_version to the
  // doc's CURRENT version, which would erase the very "you're behind" signal
  // this response needs to carry. Anonymous readers (no `user`) always resolve
  // to no-catch-up without touching doc_views (ac-36). Advisory, like
  // emitViewed below: a lookup failure must never break the read response.
  let catchUp: Awaited<ReturnType<typeof computeCatchUp>> = {
    hasCatchUp: false,
    fromVersion: null,
    lastViewedVersion: null,
  };
  try {
    catchUp = await computeCatchUp({ id: result.id, version: result.version }, user?.id);
  } catch {
    // best-effort only.
  }

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
    // spec-448 t-5 (ac-8, ac-36): piggyback the per-user last-seen marker onto
    // this same authenticated-read call site — advances doc_views to the doc's
    // current version. Anonymous reads write nothing (no `user`, ac-36).
    // Advisory: swallow failures so a marker write can never break the read
    // response, mirroring emitViewed's posture above.
    try {
      await upsertDocView(
        { userId: user.id, docId: result.id, memexId, version: result.version, channel: "rest_ui" },
        restCtx(c),
      );
    } catch {
      // best-effort only.
    }
  }

  // spec-136 t-4: include the doc's tags so the React doc view renders them inline.
  const docTags = await listDocTags(memexId, result.id);
  return c.json({
    ...result,
    decisions: decsWithFacets,
    tasks: tasksWithFacets,
    tags: docTags,
    catchUp,
  });
});

docs.post("/:id/status", async (c) => {
  const memexId = requireMemexId(c);
  const id = c.req.param("id");
  const body = await parseJsonBodyOrNull<{ status?: unknown }>(c);
  const status = requireStringType(body?.status, "status", {
    message: "Body must include a 'status' string",
  });
  // spec-122 dec-3 — carry the actor/channel onto the status_changed journal row.
  const updated = await updateDocStatus(memexId, id, status, { source: "rest", ctx: restCtx(c) });
  return c.json(updated);
});

// spec-521 (ac-4) — archiving now records WHY, and threads the actor/channel so the
// std-32 attribution lands on the row (the previous call passed no ctx at all, so
// archive writes were unattributed). `reason` is optional on the wire so an older
// client cannot 400, but the UI always sends one: the confirm asks for it.
docs.post("/:id/archive", async (c) => {
  const memexId = requireMemexId(c);
  const id = c.req.param("id");
  const body = await parseJsonBodyOrNull<{ reason?: unknown }>(c);
  const reason = typeof body?.reason === "string" ? body.reason : undefined;
  const updated = await archiveDoc(memexId, id, restCtx(c), reason);
  return c.json(updated);
});

// spec-521 (ac-4, ac-5) — the way back. Archiving was one-way before this, which is
// why it went unused: nobody archives on suspicion if they cannot undo it. Restore
// returns the doc to exactly the phase it had (archivedAt is orthogonal to status,
// so there is no phase to reinstate).
//
// ac-16: this route is the ONLY way to clear archivedAt, and it is web-only. No MCP
// tool and no in-app-agent tool reaches restoreDoc — archiving withholds content
// from agents, so both directions of that switch stay with a human (dec-6).
docs.post("/:id/restore", async (c) => {
  const memexId = requireMemexId(c);
  const id = c.req.param("id");
  const updated = await restoreDoc(memexId, id, restCtx(c));
  return c.json(updated);
});

docs.post("/:id/move", async (c) => {
  const memexId = requireMemexId(c);
  const id = c.req.param("id");
  const body = await parseJsonBodyOrNull<{ targetMemexId?: unknown }>(c);
  const targetMemexId = requireString(body?.targetMemexId, "targetMemexId", {
    message: "Body must include a 'targetMemexId' string",
  });

  // spec-293 dec-2/dec-3: a move is always whole — no per-artifact opt-out. The
  // RequestCtx carries the actor + rest_ui channel onto both emitted events
  // (dec-5). Authorization/not-found are raised inside move_doc and surfaced as
  // 404 (std-7) by moveDoc's translation — no special-casing here.
  const result = await moveDoc(memexId, id, targetMemexId, restCtx(c));
  return c.json(result);
});

docs.post("/:id/title", async (c) => {
  const memexId = requireMemexId(c);
  const id = c.req.param("id");
  const body = await parseJsonBodyOrNull<{ title?: unknown }>(c);
  const title = requireStringType(body?.title, "title", {
    message: "Body must include a 'title' string",
  });
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
  const body = await parseJsonBodyOrNull<{ tags?: unknown }>(c);
  const rawTags = requireStringArray(body?.tags, "tags", {
    message: "Body must include a 'tags' array of strings",
  });
  const addedBy = (c.get("currentUserId") as string | null) ?? null;
  const applied = await applyTagStrings(
    { channel: "rest_ui" },
    memexId,
    id,
    rawTags,
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
  const body = await parseJsonBodyOrNull<{ tagId?: unknown }>(c);
  const tagId = requireString(body?.tagId, "tagId", {
    message: "Body must include a 'tagId' string",
  });
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
  const body = await parseJsonBodyOrNull<{ content?: unknown }>(c);
  const content = requireStringType(body?.content, "content", {
    message: "Body must include a 'content' string",
  });
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
