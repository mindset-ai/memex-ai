// HTTP routes for the scoped HOOK KEY surface (spec-371, spec-430). USER-level:
// mounted at /api/hook-keys with NO memex in the path (spec-430 dec-3 — a hook key is
// per user, never per memex). Modelled on the user-level mcpTokensRouter
// (/api/mcp/tokens): every verb operates on the AUTHENTICATED caller's own keys.
//
// The plugin installer (packages/cli) calls POST / after its single device-flow auth
// to plant the least-privilege key the checkout hook authenticates with — never the
// user's MCP PAT or OAuth token (spec-371 dec-6). The raw key is returned exactly once.
//
// Auth note: the installer holds an mxt_ MCP token (not a web-session JWT), so this
// surface uses sessionWithMcpTokenMiddleware — the one session middleware that also
// accepts a valid mxt_ PAT. dec-6 is preserved: the PAT only AUTHENTICATES the mint;
// the credential we PLANT is still the least-privilege mxh_ this route returns.

import { Hono } from "hono";
import {
  mintHookKey,
  listHookKeysForUser,
  revokeHookKey,
} from "../services/hook-keys.js";
import {
  sessionWithMcpTokenMiddleware,
  type SessionEnv,
} from "../middleware/session.js";
import type { MemexHookKey } from "../db/schema.js";

const hookKeysRouter = new Hono<SessionEnv>();
hookKeysRouter.use("/*", sessionWithMcpTokenMiddleware);

// Display-safe projection: the hashed_key and the raw key are NEVER serialised.
// The raw key appears only in the POST / response, exactly once.
function toSafe(row: MemexHookKey) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdByUserId: row.createdByUserId,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}

hookKeysRouter.post("/", async (c) => {
  const userId = c.get("currentUserId") as string;
  const { name } = await c.req.json<{ name?: unknown }>().catch(() => ({ name: undefined }));
  const label =
    typeof name === "string" && name.trim().length > 0
      ? name.trim()
      : "memex checkout hook";
  const result = await mintHookKey(label, userId);
  // The ONLY time the raw key is ever returned — unrecoverable afterwards.
  return c.json({ key: result.raw, ...toSafe(result.row) }, 201);
});

hookKeysRouter.get("/", async (c) => {
  const userId = c.get("currentUserId") as string;
  const rows = await listHookKeysForUser(userId);
  return c.json(rows.map(toSafe));
});

hookKeysRouter.post("/:id/revoke", async (c) => {
  // Owner-scoped (spec-430 dec-1): the caller revokes their OWN key by id.
  const userId = c.get("currentUserId") as string;
  const id = c.req.param("id");
  const result = await revokeHookKey(id, userId);
  if (!result) return c.json({ error: "Hook key not found" }, 404);
  return c.json(toSafe(result));
});

export { hookKeysRouter };
