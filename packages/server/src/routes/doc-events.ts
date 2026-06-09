import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { and, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents } from "../db/schema.js";
import { sessionMiddleware, type SessionEnv } from "../middleware/session.js";
import type { MemexResolverEnv } from "../middleware/memex-resolver.js";
import { bus, type ChangeAction, type ChangeEvent } from "../services/bus.js";
import { requireMemexId } from "./shared.js";
import { NotFoundError } from "../types/errors.js";

type Env = MemexResolverEnv & SessionEnv;

export const docEventsRouter = new Hono<Env>();

// Pulse (b-60) t-11 / dec-5. The mutation allowlist — the historical, implicit
// contract of these streams. Existing consumers (the React UI's per-doc and
// per-Memex hooks) only ever cared about creates/updates/deletes.
const MUTATION_ACTIONS: readonly ChangeAction[] = ["created", "updated", "deleted"];

/**
 * Resolve the `?include=` query param to a `ChangeFilter.actions` allowlist,
 * parsed ONCE per connection.
 *
 *   absent | "mutations" (DEFAULT) → mutation allowlist (created/updated/deleted),
 *                                     preserving today's behaviour for every
 *                                     existing consumer.
 *   "all" + write access           → undefined (no action filter — every action,
 *                                     including reads, is delivered). Pulse uses this.
 *   "all" + read/null/unknown      → mutation allowlist (spec-199 t-5 gate).
 *   unknown value                  → mutation allowlist (safe default).
 */
function resolveIncludeActions(
  include: string | undefined,
  accessLevel: "read" | "write" | null | undefined,
): readonly ChangeAction[] | undefined {
  // spec-199 t-5: full stream is only available to write-access subscribers.
  if (include === "all" && accessLevel === "write") return undefined;
  // "mutations", absent, read-access with "all", or any unrecognised value all
  // fall through to the mutation allowlist — default-closed for reads.
  return MUTATION_ACTIONS;
}

// Gate every event stream on the session. Without this the global /events fan-out
// would leak ChangeEvents from every tenant in-process to any unauthenticated
// subscriber (and the per-doc /events/:docId handler couldn't tell whose doc it was).
docEventsRouter.use("/events", sessionMiddleware);
docEventsRouter.use("/events/*", sessionMiddleware);

/**
 * SSE endpoint for real-time document change notifications.
 *
 * Clients subscribe per-document or to all documents in their current account.
 * Both endpoints require an authenticated session (mounted behind
 * `sessionMiddleware` in `app.ts`) and filter by `currentMemexId` so a
 * subscriber can never observe mutations from another tenant.
 *
 * GET /events/:docId  — subscribe to changes for a specific document; the doc's
 *                        memexId must match the session's currentMemexId.
 * GET /events         — subscribe to all document changes scoped to the
 *                        session's currentMemexId.
 */
// std-5 exemption: doc-UUID lookup. The memex is derived from the doc's FK;
// the flat-mount path stays functional. Cross-tenant subscriptions are
// prevented by the `documents.memexId === currentMemexId` check below.
docEventsRouter.get("/events/:docId", async (c) => {
  const memexId = requireMemexId(c);
  const docId = c.req.param("docId");
  const actions = resolveIncludeActions(c.req.query("include"), c.get("currentAccessLevel"));
  const user = c.get("user");

  // Verify the doc belongs to the requesting tenant before opening the stream.
  // Without this check a session user could subscribe to any docId by guessing
  // its UUID and observe mutation timing for another tenant's doc.
  const doc = await db.query.documents.findFirst({
    where: and(eq(documents.id, docId), eq(documents.memexId, memexId)),
  });
  if (!doc) {
    throw new NotFoundError(`Document ${docId} not found`);
  }

  return streamSSE(c, async (stream) => {
    // Resolvable promise: holds the stream open. Resolves when the user's
    // membership is revoked (spec-199 t-4) or the client disconnects.
    let close!: () => void;
    const done = new Promise<void>((resolve) => { close = resolve; });

    const handler = (event: ChangeEvent) => {
      stream.writeSSE({
        event: "doc_change",
        data: JSON.stringify(event),
      });
    };

    // Filter by (memexId, docId) at the bus level — the bus subscribe filter
    // takes care of cross-tenant isolation and per-doc scoping in one place.
    // `actions` narrows by the resolved `?include=` allowlist (undefined = all).
    const unsubDoc = bus.subscribe({ memexId, docId, actions }, handler);

    // spec-199 t-4: close stream when the connected user's membership is revoked.
    const unsubRevoke = bus.subscribe(
      { userId: user.id, entity: "org_membership", actions: ["deleted"] as const },
      () => close(),
    );

    // t-19 W5: emit a `ready` event the instant the listener is attached so test
    // clients (and a future production client that wants exactly-once-since-
    // subscribe semantics) can wait for it before issuing a mutation. Without
    // this, a fixed `setTimeout` was the only race-mitigation — flaky under
    // load. The event is single-shot and harmless to ignore.
    await stream.writeSSE({ event: "ready", data: "" });

    // Keepalive every 30s to prevent proxy/Cloud Run timeouts
    const keepalive = setInterval(() => {
      stream.writeSSE({ event: "keepalive", data: "" });
    }, 30_000);

    // Clean up on disconnect — keepalive, doc-change subscription, and revoke
    // subscription must all be torn down to avoid orphan listeners.
    stream.onAbort(() => {
      clearInterval(keepalive);
      unsubDoc();
      unsubRevoke();
      close(); // Resolve done so the callback exits cleanly on client disconnect
    });

    await done;
    clearInterval(keepalive);
    unsubDoc();
    unsubRevoke();
  });
});

docEventsRouter.get("/events", (c) => {
  const memexId = requireMemexId(c);
  const actions = resolveIncludeActions(c.req.query("include"), c.get("currentAccessLevel"));
  const user = c.get("user");

  return streamSSE(c, async (stream) => {
    // Resolvable promise: holds the stream open. Resolves when the user's
    // membership is revoked (spec-199 t-4) or the client disconnects.
    let close!: () => void;
    const done = new Promise<void>((resolve) => { close = resolve; });

    const handler = (event: ChangeEvent) => {
      // Cross-tenant filter is enforced by the bus subscribe filter below,
      // but the per-Memex stream is intentionally fan-out across all docs in
      // the account (used by list pages + the drift inbox).
      stream.writeSSE({
        event: "doc_change",
        data: JSON.stringify(event),
      });
    };

    // `actions` narrows by the resolved `?include=` allowlist (undefined = all).
    const unsubDoc = bus.subscribe({ memexId, actions }, handler);

    // spec-199 t-4: close stream when the connected user's membership is revoked.
    const unsubRevoke = bus.subscribe(
      { userId: user.id, entity: "org_membership", actions: ["deleted"] as const },
      () => close(),
    );

    // t-19 W5: see per-doc handler above. Same `ready` handshake on the global
    // stream so test clients (and any future production listener that wants
    // exactly-once-since-subscribe semantics) can wait for it.
    await stream.writeSSE({ event: "ready", data: "" });

    const keepalive = setInterval(() => {
      stream.writeSSE({ event: "keepalive", data: "" });
    }, 30_000);

    stream.onAbort(() => {
      clearInterval(keepalive);
      unsubDoc();
      unsubRevoke();
      close(); // Resolve done so the callback exits cleanly on client disconnect
    });

    await done;
    clearInterval(keepalive);
    unsubDoc();
    unsubRevoke();
  });
});
