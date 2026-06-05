import { Hono } from "hono";
import { sessionMiddleware, type SessionEnv } from "../middleware/session.js";
import {
  startCliAuthRequest,
  lookupCliAuthRequest,
  completeCliAuthRequest,
  pollCliAuthRequest,
  CLI_AUTH_POLL_TIMEOUT_MS,
  CLI_AUTH_POLL_INTERVAL_MS,
} from "../services/cli-auth.js";
import { listMcpTokensForUser, revokeMcpToken } from "../services/mcp-tokens.js";

// Two routers exported from this file:
//   /api/cli/auth/* — public-ish device flow (no session needed for /start, /poll;
//                     /complete + /lookup do require a logged-in user)
//   /api/mcp/tokens/* — settings page CRUD (always session-gated)

const cliAuth = new Hono<SessionEnv>();

// POST /api/cli/auth/start — CLI claims a code. No auth required.
cliAuth.post("/start", async (c) => {
  const { reqId, code } = await startCliAuthRequest();
  return c.json({ reqId, code });
});

// GET /api/cli/auth/lookup?code=ABCD-1234 — admin's confirm page calls this to verify
// the code is real (and hasn't been consumed) before showing the Authorize UI. Returns
// minimal info; the user identity comes from the session, not from the code.
cliAuth.use("/lookup", sessionMiddleware);
cliAuth.get("/lookup", async (c) => {
  const code = c.req.query("code")?.trim();
  if (!code) return c.json({ error: "Missing code" }, 400);
  const row = await lookupCliAuthRequest(code);
  if (!row) return c.json({ status: "not_found" }, 404);
  return c.json({
    status: row.status,
    expiresAt: row.expiresAt,
  });
});

// POST /api/cli/auth/complete — admin authorises the request; we mint a token for the
// logged-in user and stash it on the request row for the CLI's next poll.
cliAuth.use("/complete", sessionMiddleware);
cliAuth.post("/complete", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const code: unknown = body?.code;
  const label: unknown = body?.label;
  if (typeof code !== "string" || !code) {
    return c.json({ error: "code is required" }, 400);
  }
  if (typeof label !== "string" || !label.trim()) {
    return c.json({ error: "label is required" }, 400);
  }
  const result = await completeCliAuthRequest(code, user.id, label.trim());
  if (!result.ok) {
    const status = result.reason === "expired" ? 410 : result.reason === "not_found" ? 404 : 409;
    return c.json({ error: result.reason }, status);
  }
  return c.json({ ok: true });
});

// GET /api/cli/auth/poll/:reqId — CLI long-polls. Wakes early if the request flips to
// completed; otherwise returns { status: "pending" } after CLI_AUTH_POLL_TIMEOUT_MS so
// the CLI can re-poll without holding the connection forever.
cliAuth.get("/poll/:reqId", async (c) => {
  const reqId = c.req.param("reqId");
  const deadline = Date.now() + CLI_AUTH_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const result = await pollCliAuthRequest(reqId);
    if (result.status === "completed") {
      return c.json({ status: "completed", token: result.token });
    }
    if (result.status === "expired") {
      return c.json({ status: "expired" }, 410);
    }
    if (result.status === "not_found") {
      return c.json({ status: "not_found" }, 404);
    }
    // pending — wait and re-check
    await new Promise((r) => setTimeout(r, CLI_AUTH_POLL_INTERVAL_MS));
  }
  return c.json({ status: "pending" });
});

// ──────────────────────────────────────────────
// Settings: MCP token list / revoke
// ──────────────────────────────────────────────

const mcpTokensRouter = new Hono<SessionEnv>();
mcpTokensRouter.use("/*", sessionMiddleware);

mcpTokensRouter.get("/", async (c) => {
  const user = c.get("user");
  const rows = await listMcpTokensForUser(user.id);
  // Never return the token hash to the client; just the metadata for display.
  const safe = rows.map((r) => ({
    id: r.id,
    label: r.label,
    prefix: r.prefix,
    lastUsedAt: r.lastUsedAt,
    revokedAt: r.revokedAt,
    createdAt: r.createdAt,
  }));
  return c.json(safe);
});

mcpTokensRouter.delete("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const result = await revokeMcpToken(id, user.id);
  if (!result) return c.json({ error: "Token not found" }, 404);
  return c.json({
    id: result.id,
    label: result.label,
    prefix: result.prefix,
    lastUsedAt: result.lastUsedAt,
    revokedAt: result.revokedAt,
    createdAt: result.createdAt,
  });
});

export { cliAuth, mcpTokensRouter };
