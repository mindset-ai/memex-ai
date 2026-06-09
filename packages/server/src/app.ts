import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { errorHandler } from "./middleware/error-handler.js";
import { sessionMiddleware } from "./middleware/session.js";
import { memexesRouter } from "./routes/memexes.js";
import { docs } from "./routes/documents.js";
import { comments } from "./routes/comments.js";
import { decisionsRouter } from "./routes/decisions.js";
import { tasksRouter } from "./routes/tasks.js";
import { issuesRouter } from "./routes/issues.js";
import { issuesList } from "./routes/issues-list.js";
import { acsRouter } from "./routes/acs.js";
import { emissionKeysRouter } from "./routes/emission-keys.js";
import { discordWebhookRouter } from "./routes/discord-webhook.js";
import { docMembersRouter } from "./routes/doc-members.js";
import { docAssigneesRouter } from "./routes/doc-assignees.js";
import { executionPlans } from "./routes/execution-plans.js";
import { llmRouter } from "./routes/llm.js";
import { createNodeWebSocket } from "@hono/node-ws";
import { createVoiceRouter } from "./routes/voice.js";
import { docEventsRouter } from "./routes/doc-events.js";
import { activity } from "./routes/activity.js";
import { analytics } from "./routes/analytics.js";
import { waitlist } from "./routes/waitlist.js";
import { auth } from "./routes/auth.js";
import { invitesAcceptRouter, invitesAdminRouter } from "./routes/invites.js";
import { teamRouter } from "./routes/team.js";
import { shareRouter } from "./routes/share.js";
import { backstageRouter } from "./routes/backstage.js";
import { cliAuth, mcpTokensRouter } from "./routes/cli-auth.js";
import { oauth, isOAuthEnabled } from "./routes/oauth/index.js";
import { wellKnown, publicBaseUrl } from "./routes/well-known.js";
import driftRouter from "./routes/drift.js";
import { search } from "./routes/search.js";
import { handhold } from "./routes/handhold.js";
import { onboarding } from "./routes/onboarding.js";
import { testEventsRouter } from "./routes/test-events.js";
import { testOnlyRouter } from "./routes/__test__.js";
import { hostGuard, memexResolver } from "./middleware/memex-resolver.js";
import { rewriteBriefPathToSpec } from "./services/redirects.js";
import { isAllowedOrigin } from "./middleware/cors-policy.js";
import { meRouter } from "./routes/me.js";
import { whatsNewRouter } from "./routes/whats-new.js";
import { orgsRouter, orgsCurrentRouter } from "./routes/orgs.js";
import { scaffoldRouter } from "./routes/scaffold.js";
import { namespacesRouter } from "./routes/namespaces.js";
import { consentRouter } from "./routes/consent.js";
import { getBusRelay } from "./services/bus-relay.js";
import { createMcpServer } from "./mcp/tools.js";
import {
  migrationErrorMessage,
  argMigrationErrorMessage,
  phaseValueMigrationErrorMessage,
} from "./mcp/migration-map.js";
import { verifyMcpToken, bumpLastUsed } from "./services/mcp-tokens.js";
import { verifyAccessToken } from "./services/oauth/access-tokens.js";
import { isDevMode, ensureDevMemberships } from "./middleware/session.js";
import { upsertUserByEmail } from "./services/users.js";
import { upsertSession, parseClientIp } from "./services/mcp-telemetry.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = new Hono();

// spec-190 t-1 / dec-9: WebSocket support for the voice loop's audio leg.
// createNodeWebSocket binds to THIS app instance; index.ts calls
// injectWebSocket(server) after serve(). upgradeWebSocket registers the voice
// WS route (mounted below). The LLM text proxy stays on SSE (dec-2).
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

// CORS policy lives in middleware/cors-policy.ts so it can be unit-tested without
// pulling in the DB connection. See that file for the rationale on each entry.

app.use("*", secureHeaders());

app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return null;
      return isAllowedOrigin(origin) ? origin : null;
    },
  })
);

app.onError(errorHandler);

// Per std-2: hosts other than the apex / dev hosts return 404. There is no
// subdomain-based tenant routing.
app.use("*", hostGuard);

// b-105 dec-6 — permanent 301 from legacy /briefs/b-N paths (and child paths)
// to /specs/spec-N. Runs BEFORE memexResolver because we want the redirect
// to fire regardless of whether the underlying tenant resolves locally —
// the URL shape is the only signal we need, and resolving the destination
// is the subsequent request's concern. Pure regex match against the path
// (no DB lookup); see services/redirects.ts rewriteBriefPathToSpec for the
// five patterns covered.
app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  // Strip leading slash — rewriteBriefPathToSpec patterns expect the path
  // without it.
  const path = url.pathname.replace(/^\//, "");
  const rewrite = rewriteBriefPathToSpec(path);
  if (rewrite) {
    const destination = `/${rewrite.destination}${url.search}`;
    return c.redirect(destination, rewrite.status);
  }
  return next();
});

// Per dec-3: tenants live in the path. memexResolver parses /<namespace>/<memex>/
// (or /api/<namespace>/<memex>/...) and attaches the resolved namespace + memex
// to the request context. Authorization happens per-route. Routes that don't
// carry the prefix (entity-keyed lookups, /api/health, etc.) are skipped.
app.use("*", memexResolver);

app.get("/api/health", (c) => {
  // Cross-instance bus relay status (spec-156 ac-12). The std-17 post-deploy
  // smoke asserts `relay.listening` is true on int and prod. When no relay is
  // attached (single-process / local dev / tests) the field is null — distinct
  // from "attached but not yet listening", so smoke can tell the two apart.
  const relay = getBusRelay();
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    relay: relay ? relay.health() : null,
  });
});

// Bootstrap installer scripts. Served at /install.{sh,ps1} (no /api prefix) so the
// curl/iwr commands fit on one terminal line. Cached per-process — the contents are
// part of the deployed image and don't change at runtime.
//
// In dev `__dirname` is `src/`; in prod it's `dist/`. The build step copies the
// bootstrap directory next to the compiled output so a single relative path works in
// both modes.
const bootstrapDir = join(__dirname, "..", "bootstrap");
let cachedSh: string | null = null;
let cachedPs1: string | null = null;
// Dev-only static bearer for local MCP work. Gated by isDevMode() — in any
// non-dev environment this falls through to verifyMcpToken which rejects it
// as a normal unknown token. The value is intentionally loud + obvious so a
// reader of leaked logs can't mistake it for a real PAT.
const DEV_LOCAL_BEARER = "mxt_DEV_LOCAL_ONLY_NEVER_PRODUCTION";

// install.sh / install.ps1 contain a `{{API_BASE_URL}}` placeholder so the
// "Source: …" comment header matches the host they're served from. Substitute
// at first-read time using APP_BASE_URL (the same env var Cloud Run gets per
// deploy-config.sh). Dev fallback matches int's current host so local server
// behaves unchanged.
function renderInstallTemplate(raw: string): string {
  const base = process.env.APP_BASE_URL ?? "https://int.memex.ai";
  return raw.replace(/\{\{API_BASE_URL\}\}/g, base);
}

app.get("/install.sh", async (c) => {
  if (!cachedSh) {
    const raw = await readFile(join(bootstrapDir, "install.sh"), "utf8");
    cachedSh = renderInstallTemplate(raw);
  }
  c.header("Cache-Control", "public, max-age=300");
  return c.body(cachedSh, 200, { "Content-Type": "text/x-shellscript; charset=utf-8" });
});
app.get("/install.ps1", async (c) => {
  if (!cachedPs1) {
    const raw = await readFile(join(bootstrapDir, "install.ps1"), "utf8");
    cachedPs1 = renderInstallTemplate(raw);
  }
  c.header("Cache-Control", "public, max-age=300");
  return c.body(cachedPs1, 200, { "Content-Type": "text/x-powershell; charset=utf-8" });
});

// The /install/ac-emit-vitest.ts route was removed in spec-89 v0.1.0.
// External consumers now install via npm: `npm install --save-dev
// @memex-ai-ac/vitest`. The ac-emission guidance topic documents the new
// install path. There are no known external consumers of the previous
// curl-based template; the cut was deliberate while breaking changes are
// still cheap.

// ── t-18 of doc-15: path-based tenant routing (std-2) ──────────────────────
//
// F.3 of the doc-15 narrative section locks in two mount shapes:
//
//   1. Tenancy-scoped surfaces live under /api/<namespace>/<memex>/<resource>.
//      The memexResolver middleware (applied globally above) parses the
//      `/<ns>/<mx>/` prefix from the path and sets ctx.namespace + ctx.memex;
//      the per-route sessionMiddleware reads ctx.memex to populate
//      currentMemexId. Cross-namespace requests return 404 (std-7).
//
//   2. Entity-keyed UUID lookups stay flat (/api/docs/:uuid, /api/comments/:id/resolve,
//      etc.) per the std-5 exemption: "the namespace is determined by the entity,
//      not by the caller's membership set." The same routers are mounted at the
//      flat path so single-membership callers (and dev mode) continue to work
//      without re-typing the prefix.
//
//   3. Caller-scoped surfaces (/api/auth, /api/me, /api/orgs, /api/consent,
//      /api/cli/auth, /api/share/:token) stay flat — they have no per-memex
//      semantics and don't benefit from a path prefix.
//
// Why mount tenancy routers twice rather than alias-redirect:
//   - The flat mount is the actual entrypoint for entity-keyed UUID lookups,
//     not an alias. Both shapes execute the same handler with the same
//     `requireMemexId(c)` flow; the difference is purely where ctx.memex
//     comes from (path resolution vs single-membership inference).
//   - Keeping both mounts in lockstep means there's exactly one router per
//     resource, so future handler changes don't risk drift.

// Tenancy-scoped surfaces — path-prefixed (preferred per dec-3 / F.3 of doc-15).
app.route("/api/:namespace/:memex/docs", docEventsRouter);
app.route("/api/:namespace/:memex/docs", docs);
app.route("/api/:namespace/:memex/comments", comments);
app.route("/api/:namespace/:memex/decisions", decisionsRouter);
app.route("/api/:namespace/:memex/tasks", tasksRouter);
app.route("/api/:namespace/:memex/issues", issuesRouter);
app.route("/api/:namespace/:memex/acs", acsRouter);
app.route("/api/:namespace/:memex/emission-keys", emissionKeysRouter);
app.route("/api/:namespace/:memex/discord-webhook", discordWebhookRouter);
// spec-118 — per-Spec roles (editor/reviewer) + ticket-style assignment.
app.route("/api/:namespace/:memex/doc-members", docMembersRouter);
app.route("/api/:namespace/:memex/doc-assignees", docAssigneesRouter);
app.route("/api/:namespace/:memex/execution-plans", executionPlans);
app.route("/api/:namespace/:memex/drift", driftRouter);
// spec-64 t-1 — REST search over searchMemex. Path-prefixed only: a search is
// inherently scoped to one Memex, so (like activity) there's no flat
// entity-keyed mount. The route reads the path-resolved memex from context.
app.route("/api/:namespace/:memex/search", search);
// spec-158 t-3 — Memex-level Issues page feed (cross-Spec roll-up of open
// issues). Path-prefixed only, like search/activity: it's inherently scoped to
// one Memex and is org-membership gated (std-4), so there's no flat entity-keyed
// mount. STRICT sessionMiddleware lives inside the router (non-member → 404).
app.route("/api/:namespace/:memex/issues-list", issuesList);
// Pulse history (b-60 t-12). Path-prefixed only — the timeline is inherently
// per-Memex, so there's no flat entity-keyed mount (a bare /api/activity has no
// memex to scope to).
app.route("/api/:namespace/:memex/activity", activity);
// Spec analytics for the Insights page (spec-179). Path-prefixed only — the
// aggregates are inherently per-Memex, same reasoning as /activity above.
app.route("/api/:namespace/:memex/analytics", analytics);
// spec-178 t-6 — handhold onboarding demo reset. Path-prefixed only: the reset
// is gated to the owner of a PERSONAL Memex (std-7 404 otherwise), so the memex
// must come from the resolved /<ns>/<mx>/ path — there's no flat entity-keyed
// mount. STRICT sessionMiddleware + the owner gate live inside the router.
app.route("/api/:namespace/:memex/handhold", handhold);
app.use("/api/:namespace/:memex/llm/*", sessionMiddleware);
app.route("/api/:namespace/:memex/llm", llmRouter);
// spec-190 t-1: voice WS proxy, tenancy-scoped. Deliberately NO sessionMiddleware
// on /voice/* broadly — the WS handshake (/voice/session) can't carry an
// Authorization header, so the router authenticates the connect-query token
// itself (routes/voice.ts). memexResolver (global) has already resolved c.memex.
// spec-190 t-3: the guide's LLM text leg (/voice/guide-chat) IS a normal HTTP
// POST carrying a Bearer token, so it gets sessionMiddleware — scoped to just
// that path so the WS route stays middleware-free.
app.use("/api/:namespace/:memex/voice/guide-chat", sessionMiddleware);
app.route("/api/:namespace/:memex/voice", createVoiceRouter(upgradeWebSocket));
// Tenancy-scoped membership / admin surfaces — drift fix to t-12. These were
// previously mounted flat at /api/team, /api/invites, and /api/orgs/current/*
// but their handlers all read `ctx.currentMemexId`, which memexResolver only
// populates for `/api/<ns>/<mx>/...` URLs. Mounting them under the tenant
// prefix is the only shape that actually works (prefix-only per dec-9 — no
// alias layers; the flat mounts have been removed).
app.route("/api/:namespace/:memex/team", teamRouter);
app.route("/api/:namespace/:memex/invites", invitesAdminRouter);
app.route("/api/:namespace/:memex/orgs", orgsCurrentRouter);

// spec-111 t-5 — per-Memex settings + public read surface.
//
//   GET   /api/:namespace/:memex/memexes/:id   — public read (canReadMemex)
//   PATCH /api/:namespace/:memex/memexes/:id    — owner/admin visibility flip
//
// One router; per-verb middleware lives INSIDE it (see routes/memexes.ts):
//   - PATCH sits behind STRICT sessionMiddleware + adminGate (administrators
//     only; anonymous → 401 before reaching it).
//   - GET sits behind PERMISSIVE publicSessionMiddleware so anonymous callers
//     reach the handler with currentUserId=null and let canReadMemex decide
//     (public → read; private → 404 per std-7).
app.route("/api/:namespace/:memex/memexes", memexesRouter);

// Tenancy-scoped surfaces — flat mounts for entity-keyed UUID lookups (std-5 exemption).
// The handlers themselves don't change shape; they continue to call requireMemexId(c)
// which reads currentMemexId set by sessionMiddleware from either the path-resolved
// memex (above) or the caller's single membership (below). For multi-membership
// callers, only the path-prefixed mount works — that's the std-5 ambiguity contract.
app.route("/api/docs", docEventsRouter);
app.route("/api/docs", docs);
app.route("/api/comments", comments);
app.route("/api/decisions", decisionsRouter);
app.route("/api/tasks", tasksRouter);
app.route("/api/issues", issuesRouter);
app.route("/api/acs", acsRouter);
app.route("/api/execution-plans", executionPlans);
app.route("/api/drift", driftRouter);
// feat-ac-spike V0.0.1 — test-event receiver for AC pass/fail emissions from the codebase.
app.route("/api/test-events", testEventsRouter);
// /api/llm/* migrated to sessionMiddleware (t-13). Legacy middleware/auth.ts deleted.
app.use("/api/llm/*", sessionMiddleware);
app.route("/api/llm", llmRouter);

// Caller-scoped + public surfaces — stay flat (no path prefix). These have no
// per-memex semantics, so prefixing them would be noise.
app.route("/api/waitlist", waitlist);
app.route("/api/auth", auth);
// /api/onboarding — spec-206: the user-level first-run greeting gate for the
// Specky welcome (greet-eligibility read + once-per-user stamp). User-keyed, no
// memex semantics, so it stays flat.
app.route("/api/onboarding", onboarding);
// /api/orgs — t-14 + t-16 of doc-15. Single org-creation + admin surface.
// Replaces the retired /api/accounts and /api/account mounts.
app.route("/api/orgs", orgsRouter);
// /api/orgs/:orgId/scaffold — read the merged base+org scaffold and administer
// per-Org GuidanceBlock additions (b-68 t-10). Mounted at /api/orgs (not under
// the tenancy prefix) because the org id alone identifies the resource — the
// shape is org-keyed UUID lookup, not tenancy-scoped path resolution. The
// router enforces std-7 (404 for non-members AND non-admin writes) internally.
app.route("/api/orgs", scaffoldRouter);
// /api/namespaces — doc-19 t-3: namespace-keyed endpoints (slug check, rename,
// home payload, sibling-memex creation).
app.route("/api/namespaces", namespacesRouter);
// /api/consent — t-13 of doc-15. The domain-match consent prompt the React UI
// surfaces on session start. SSO no longer auto-inserts memberships; this is
// the only path that does.
app.route("/api/consent", consentRouter);
// `/api/invites/accept` stays flat — the invite token IS the authorization;
// caller doesn't have a tenant context yet (joining the invite is what grants
// them one). The mint/list/revoke trio moved under the tenant prefix above.
app.route("/api/invites", invitesAcceptRouter);
// Caller-scoped endpoints — namespace picker (std-5) and minimal session shape.
app.route("/api/me", meRouter);
// spec-200: global What's New feed (not tenant-scoped).
app.route("/api/whats-new", whatsNewRouter);
// PUBLIC: share routes skip session middleware — guests access shared docs by token alone (t-10).
app.route("/api/share", shareRouter);

// Platform backstage — dev-mode only today. Gated inside the router itself. Registered on
// the bare domain so operators can hit it without a tenant subdomain.
app.route("/api/backstage", backstageRouter);

// Device-flow installer + token settings (t-14).
app.route("/api/cli/auth", cliAuth);
app.route("/api/mcp/tokens", mcpTokensRouter);

// OAuth 2.1 + DCR + PKCE (b-31 W1). Gated by OAUTH_ENABLED=1 so the entire
// surface (routes + well-known discovery) is dead until explicitly turned on.
// Existing `mxt_` users are unaffected when this flag is off.
if (isOAuthEnabled()) {
  app.route("/api/oauth", oauth);
  app.route("/.well-known", wellKnown);
}

// Test-only endpoints for driving the Anthropic fake queue from Playwright. Mounted ONLY
// when MEMEX_ANTHROPIC_FAKE=1 is set. See routes/__test__.ts and agent/anthropic-fake.ts.
if (process.env.MEMEX_ANTHROPIC_FAKE === "1") {
  app.route("/api/__test__", testOnlyRouter);
}

// MCP endpoint — fresh server instance per request (stateless, no concurrency issues).
//
// Two auth paths coexist per b-31 dec-1:
//   - `Bearer mxt_…` long-lived MCP token (services/mcp-tokens.ts) — existing
//     path, byte-identical to before the OAuth work landed.
//   - `Bearer <JWT>` OAuth 2.1 access token (services/oauth/access-tokens.ts) —
//     only active when OAUTH_ENABLED=1. Gated by the same flag as the
//     /api/oauth/* routes + /.well-known docs.
//
// The token resolves to a userId either way; tools then resolve workspace
// per-call (either from a `workspace` argument or by inferring from a
// UUID-bearing argument). Membership is checked on every account-scoped tool call.
app.all("/mcp", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    // Per RFC 6750 §3 — challenge clients with WWW-Authenticate so they know
    // where to find OAuth metadata. The `resource_metadata` parameter is the
    // MCP spec extension that points at /.well-known/oauth-protected-resource.
    if (isOAuthEnabled()) {
      c.header(
        "WWW-Authenticate",
        `Bearer resource_metadata="${publicBaseUrl(c)}/.well-known/oauth-protected-resource/mcp"`,
      );
    }
    return c.json(
      {
        error: "Missing Authorization header",
        message:
          "MCP requires a Bearer token. Use the Anthropic Connectors picker (Claude.ai) or run `claude mcp add memex --transport http https://memex.ai/mcp`.",
      },
      401
    );
  }
  const raw = authHeader.slice(7);

  // Token-prefix fork — `mxt_` → existing path; anything else → OAuth path
  // (when enabled). The mxt_ branch is byte-identical to the pre-OAuth flow.
  //
  // Per b-31 dec-8, OAuth callers carry an `org` claim that scopes the token
  // to the user's personal Memex + one chosen Org. `orgFilter === undefined`
  // is the PAT shape and explicitly preserved here so the existing surface is
  // unchanged.
  let userId: string;
  let orgFilter: string | null | undefined;
  if (raw.startsWith("mxt_")) {
    // Hardcoded dev-only bearer. Bypasses the `mcp_tokens` table entirely so
    // that local dev survives any test or admin action that cycles the dev
    // user (which would otherwise cascade-delete the stored token row).
    // Strict isDevMode() gate — in production this branch is dead code and
    // the bearer falls through to verifyMcpToken which will reject it as a
    // normal unknown token. isDevMode() itself throws if NODE_ENV=production
    // lacks GOOGLE_CLIENT_ID, so it cannot silently enable here.
    if (raw === DEV_LOCAL_BEARER && isDevMode()) {
      const devUser = await upsertUserByEmail("dev@memex.ai");
      await ensureDevMemberships(devUser.id);
      userId = devUser.id;
      orgFilter = undefined;
    } else {
      const token = await verifyMcpToken(raw);
      if (!token) {
        return c.json(
          {
            error: "Invalid or revoked MCP token",
            code: "token_invalid",
            message: "Re-run the Memex installer to re-authorize.",
          },
          401
        );
      }
      bumpLastUsed(token.id);
      userId = token.userId;
      orgFilter = undefined; // PAT — user-wide, no org filter
    }
  } else if (isOAuthEnabled()) {
    try {
      const claims = verifyAccessToken(raw);
      userId = claims.sub;
      orgFilter = claims.org; // null = personal-only; UUID = org-scoped
    } catch {
      c.header(
        "WWW-Authenticate",
        `Bearer error="invalid_token", resource_metadata="${publicBaseUrl(c)}/.well-known/oauth-protected-resource/mcp"`,
      );
      return c.json(
        {
          error: "Invalid OAuth access token",
          code: "token_invalid",
          message: "Reconnect via the Anthropic Connectors picker or re-run `claude mcp add memex`.",
        },
        401
      );
    }
  } else {
    // OAuth disabled + non-mxt_ token → reject identically to mxt_-invalid so
    // we don't leak that an OAuth surface exists in a different deployment.
    return c.json(
      {
        error: "Invalid or revoked MCP token",
        code: "token_invalid",
        message: "Re-run the Memex installer to re-authorize.",
      },
      401
    );
  }

  // doc-14 / dec-5: hard-cut tools intercept BEFORE the MCP transport so the
  // client gets a structured migration error pointing at the replacement
  // (instead of the SDK's generic "method not found"). Cut tools deliberately
  // aren't registered with the McpServer so they don't bloat the agent's
  // tool-list response — the count test in tools-coverage.regression.test.ts
  // pins the catalogue at 28-32. See migration-map.ts for the mapping.
  type RpcCall = {
    method?: string;
    params?: { name?: string; arguments?: unknown };
    id?: unknown;
  };
  const cloned = c.req.raw.clone();
  let parsed: RpcCall | null = null;
  try {
    const text = await cloned.text();
    parsed = text ? (JSON.parse(text) as RpcCall) : null;
  } catch {
    parsed = null;
  }
  if (parsed && parsed.method === "tools/call" && typeof parsed.params?.name === "string") {
    // Tool-name migration (doc-14): removed tool names get a structured error
    // naming the replacement.
    const msg = migrationErrorMessage(parsed.params.name);
    if (msg) {
      return c.json({
        jsonrpc: "2.0",
        id: parsed.id ?? null,
        result: {
          isError: true,
          content: [{ type: "text" as const, text: msg }],
        },
      });
    }

    // b-42 t-4 — argument-name migration (b-36 canonical-ref refactor):
    // stale clients sending the old identity arg names (docId, taskId, etc.)
    // get a structured hint pointing at the new `ref` field. Fires before the
    // MCP server validates so the message names the actual problem instead of
    // letting a raw Zod "expected string, received undefined" bubble up.
    const args = parsed.params.arguments;
    if (args && typeof args === "object" && !Array.isArray(args)) {
      const argMsg = argMigrationErrorMessage(args as Record<string, unknown>);
      if (argMsg) {
        return c.json({
          jsonrpc: "2.0",
          id: parsed.id ?? null,
          result: {
            isError: true,
            content: [{ type: "text" as const, text: argMsg }],
          },
        });
      }

      // spec-181 / dec-1 — phase-VALUE migration (`plan` → `specify`): an
      // inbound phase-sense status/target of "plan" gets a structured error
      // naming the rename + the corrective action (re-read tools/list), rather
      // than the generic Zod enum error the renamed enums now produce. No
      // alias/coercion. The `plan` comment-type vocabulary is untouched (it
      // arrives on `type`/`types`, not the phase-sense fields checked here).
      const phaseMsg = phaseValueMigrationErrorMessage(
        args as Record<string, unknown>,
      );
      if (phaseMsg) {
        return c.json({
          jsonrpc: "2.0",
          id: parsed.id ?? null,
          result: {
            isError: true,
            content: [{ type: "text" as const, text: phaseMsg }],
          },
        });
      }
    }
  }

  // MCP session-id correlation: the protocol's correlation token. SDK stays
  // in stateless mode (sessionIdGenerator: undefined) so we keep per-request
  // transports. The Hono layer injects the header on the response if the
  // client didn't send one; per the MCP spec the client SHOULD echo it on
  // subsequent requests (Claude Code does, verified empirically).
  const incomingSession = c.req.header("Mcp-Session-Id");
  const sessionId = incomingSession ?? randomUUID();

  // Telemetry capture (mcp_sessions). Identity columns:
  //   - User-Agent: always present; parsed name+version live on the row.
  //   - X-Forwarded-For: set by Cloud Run in prod; null locally (no proxy).
  //   - clientInfo: MCP-spec canonical identity, only sent on the
  //     `initialize` POST. The session-upsert COALESCEs it into the row
  //     once the initialize request lands (the first request for a session
  //     is often the SSE GET, which has no body).
  const userAgent = c.req.header("User-Agent") ?? null;
  const ipAddress = parseClientIp(c.req.header("X-Forwarded-For"));
  let clientInfo: unknown = null;
  if (c.req.method === "POST") {
    try {
      const cloned = c.req.raw.clone();
      const body = (await cloned.json()) as {
        method?: string;
        params?: { clientInfo?: unknown };
      };
      if (body.method === "initialize") {
        clientInfo = body.params?.clientInfo ?? null;
      }
    } catch {
      // Body wasn't JSON or wasn't the initialize call — fine, we'll pick
      // up clientInfo on a later request that does carry it.
    }
  }

  // Session upsert MUST land before tool calls fire — mcp_tool_calls has a
  // FK to mcp_sessions(session_id). The cost is one Postgres round-trip
  // (~1ms local, ~10ms cross-region) which is noise compared to the tool
  // work itself. upsertSession swallows errors internally so a DB hiccup
  // can't break the MCP request path even though we await it here.
  await upsertSession({
    sessionId,
    userId,
    userAgent,
    clientInfo,
    ipAddress,
  });

  const mcpServer = createMcpServer(userId, orgFilter, sessionId);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  await mcpServer.connect(transport);

  const response = await transport.handleRequest(c.req.raw);

  // Web Response objects are immutable after construction; we have to
  // rebuild with the additional header. Body is a ReadableStream which
  // passes through fine.
  const newHeaders = new Headers(response.headers);
  newHeaders.set("Mcp-Session-Id", sessionId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
});

export { app, injectWebSocket };
