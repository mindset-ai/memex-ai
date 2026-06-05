// OAuth 2.1 + DCR + PKCE router for the Anthropic Connectors Directory (b-31).
//
// Mounted at /api/oauth/* per app.ts wiring. The OAuth metadata advertises the
// non-prefixed shape (/oauth/authorize, /oauth/token, /oauth/register) — the
// /.well-known/oauth-authorization-server document rewrites these to point at
// /api/oauth/* so MCP clients hit the right URLs.
//
// **Feature flag**: gated by `OAUTH_ENABLED=1`. app.ts conditionally mounts
// this router so when disabled the entire surface returns 404, dead code
// at the route level. Existing `mxt_` users are unaffected either way.

import { Hono } from "hono";
import type { SessionEnv } from "../../middleware/session.js";
import { register } from "./register.js";
import { authorize } from "./authorize.js";
import { token } from "./token.js";
import { revoke } from "./revoke.js";

export const oauth = new Hono<SessionEnv>();

oauth.route("/register", register);
oauth.route("/authorize", authorize);
oauth.route("/token", token);
oauth.route("/revoke", revoke);

export function isOAuthEnabled(): boolean {
  return process.env.OAUTH_ENABLED === "1";
}
