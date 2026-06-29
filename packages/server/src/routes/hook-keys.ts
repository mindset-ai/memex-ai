// HTTP routes for the scoped HOOK KEY surface (spec-371). Tenant-scoped, mounted
// under /api/:namespace/:memex/hook-keys. Mirrors routes/emission-keys.ts: every
// verb is a membership-gated operation (the key is a secret).
//
// The plugin installer (packages/cli) calls POST / after its device-flow auth to
// plant a least-privilege key the checkout hook authenticates with — never the
// user's MCP PAT or OAuth token (dec-6). The raw key is returned exactly once.
//
// Auth note (spec-371): the device flow yields an mxt_ MCP token, not a web-session
// JWT, so this surface uses sessionWithMcpTokenMiddleware — the one session route
// that also accepts a valid mxt_ PAT. dec-6 is preserved: the PAT only AUTHENTICATES
// the mint; the credential we PLANT is still the least-privilege mxh_ this route
// returns. Membership is still enforced (the PAT resolves a user, the std-5 tail
// 404s a non-member), so a PAT can only mint a key for a memex its owner belongs to.

import { Hono } from "hono";
import {
  mintHookKey,
  listHookKeysForMemex,
  revokeHookKey,
} from "../services/hook-keys.js";
import {
  sessionWithMcpTokenMiddleware,
  type SessionEnv,
} from "../middleware/session.js";
import type { MemexResolverEnv } from "../middleware/memex-resolver.js";
import { requireMemexId } from "./shared.js";
import type { MemexHookKey } from "../db/schema.js";

type Env = MemexResolverEnv & SessionEnv;

const hookKeysRouter = new Hono<Env>();
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
  const memexId = requireMemexId(c);
  const createdByUserId = c.get("currentUserId") as string;
  const { name } = await c.req.json<{ name?: unknown }>().catch(() => ({ name: undefined }));
  const label =
    typeof name === "string" && name.trim().length > 0
      ? name.trim()
      : "memex checkout hook";
  const result = await mintHookKey(memexId, label, createdByUserId);
  // The ONLY time the raw key is ever returned — unrecoverable afterwards.
  return c.json({ key: result.raw, ...toSafe(result.row) }, 201);
});

hookKeysRouter.get("/", async (c) => {
  const memexId = requireMemexId(c);
  const rows = await listHookKeysForMemex(memexId);
  return c.json(rows.map(toSafe));
});

hookKeysRouter.post("/:id/revoke", async (c) => {
  const memexId = requireMemexId(c);
  const id = c.req.param("id");
  const result = await revokeHookKey(id, memexId);
  if (!result) return c.json({ error: "Hook key not found" }, 404);
  return c.json(toSafe(result));
});

export { hookKeysRouter };
