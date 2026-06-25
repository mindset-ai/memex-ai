import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { sessionMiddleware, type SessionEnv } from "../middleware/session.js";
import { listAccessibleNamespaces } from "../services/users.js";
import { bus, type ChangeEvent } from "../services/bus.js";

// /api/me/* — caller-scoped endpoints that don't require a resolved memex. The
// namespace-picker (per std-5) lives here: when the React UI sees the session
// has no current memex (because the user belongs to multiple), it fetches this
// list and renders a chooser. Browsers then navigate to /<namespace>/<memex>/.

export const meRouter = new Hono<SessionEnv>();

meRouter.use("*", sessionMiddleware);

// GET /api/me/namespaces — every namespace the caller can access. Per doc-19,
// orgs without any memex still appear (empty `memexes` array) so the React UI
// can surface them in the switcher and link to the Org page.
meRouter.get("/namespaces", async (c) => {
  const user = c.get("user");
  const namespaces = await listAccessibleNamespaces(user.id);
  return c.json({
    namespaces: namespaces.map((n) => ({
      namespaceId: n.namespaceId,
      namespaceSlug: n.namespaceSlug,
      kind: n.kind,
      role: n.role,
      // Per-memex role retained for backwards-compat with the React UI
      // consumer. Caller's role is the same for every memex in the namespace
      // (membership is per-org, not per-memex).
      memexes: n.memexes.map((m) => ({
        memexId: m.memexId,
        memexSlug: m.memexSlug,
        name: m.name,
        role: n.role,
      })),
    })),
  });
});

// GET /api/me/events — per-user SSE channel. Mirrors the per-Memex /events
// surface but filters on `userId` so user-scoped resources (mcp_tokens, the
// user-side of org_membership / org_consent) trigger refetches in real time.
// Pages like /settings/tokens subscribe via the useUserChangeStream hook.
meRouter.get("/events", (c) => {
  const user = c.get("user");

  return streamSSE(c, async (stream) => {
    // Resolvable promise: holds the stream open. Resolves when the user's
    // membership is revoked (spec-199 t-4) or the client disconnects.
    let close!: () => void;
    const done = new Promise<void>((resolve) => { close = resolve; });

    const handler = (event: ChangeEvent) => {
      // spec-199 t-4: close stream silently on membership revocation — do not
      // forward the event to the client (clean disconnect, no error sent).
      if (event.entity === "org_membership" && event.action === "deleted") {
        close();
        return;
      }
      stream.writeSSE({
        event: "user_change",
        data: JSON.stringify(event),
      });
    };

    // bus.subscribe filters by userId at dispatch — Memex-scoped events with
    // no userId are correctly filtered out (they have userId === undefined and
    // the filter compares strict equality).
    //
    // b-60 (std-8 SSE contract): default to mutation-only delivery. The bus now
    // also carries read interactions (viewed/searched/assessed/called) that carry
    // a userId, so without this filter they would reach useUserChangeStream and
    // trigger spurious refetches in consumers that predate the widening. Opt into
    // the full stream with ?include=all; absent/any-other value = mutations only.
    const actions =
      c.req.query("include") === "all"
        ? undefined
        : (["created", "updated", "deleted"] as const);
    const unsubscribe = bus.subscribe({ userId: user.id, actions }, handler);

    // Single-shot `ready` handshake — same pattern as the per-doc / per-Memex
    // streams so test clients can wait for it before issuing a mutation.
    await stream.writeSSE({ event: "ready", data: "" });

    const keepalive = setInterval(() => {
      stream.writeSSE({ event: "keepalive", data: "" });
    }, 30_000);

    stream.onAbort(() => {
      clearInterval(keepalive);
      unsubscribe();
      close(); // Resolve done so the callback exits cleanly on client disconnect
    });

    await done;
    clearInterval(keepalive);
    unsubscribe();
  });
});

// GET /api/me — minimal session shape. Useful for the SPA to hydrate its auth
// state without pulling the full membership list.
meRouter.get("/", async (c) => {
  const user = c.get("user");
  const currentMemexId = c.get("currentMemexId");
  const currentRole = c.get("currentRole");
  return c.json({
    user: { id: user.id, email: user.email, name: user.name, namespaceId: user.namespaceId },
    currentMemexId,
    currentRole,
  });
});
