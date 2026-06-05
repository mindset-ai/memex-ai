// Mint an mxt_ MCP token for the local dev-fallback user.
//
// Background: the /mcp endpoint requires a Bearer token. In prod the React UI's
// /settings/tokens page handles minting after an SSO login. In local dev there's
// no SSO; the session middleware auto-creates `dev@memex.ai` when GOOGLE_CLIENT_ID
// is unset, but that user can't use the UI flow. This script calls the same
// `mintMcpToken` service function the UI path eventually invokes, against the
// local dev user, and prints the raw token.
//
// Prerequisites:
//   1. Postgres container running: `docker compose up -d`
//   2. .env stripped of GOOGLE_CLIENT_ID (see docs/local-mcp-client.md)
//   3. Server has booted at least once and the dev user exists. Trigger creation
//      by hitting any session-middleware endpoint first, e.g.:
//        curl http://localhost:8080/api/auth/me
//
// Usage:
//   pnpm tsx packages/server/scripts/mint-dev-token.ts
//
// The raw token is printed once and only once. The DB stores only the hash; if
// you lose the printed value, re-run the script (or revoke the old token in the
// UI and mint a new one).
//
// See docs/local-mcp-client.md for the full local-MCP-client setup.
import "dotenv/config";
import { mintMcpToken } from "../src/services/mcp-tokens.js";
import { db } from "../src/db/connection.js";
import { users } from "../src/db/schema.js";
import { eq } from "drizzle-orm";

const DEV_EMAIL = "dev@memex.ai";

const user = await db.query.users.findFirst({ where: eq(users.email, DEV_EMAIL) });
if (!user) {
  console.error(
    `No user found with email ${DEV_EMAIL}. ` +
      `Hit /api/auth/me first (with the server running) to trigger dev-fallback user creation.`,
  );
  process.exit(1);
}

const minted = await mintMcpToken(user.id, "local-dev");
console.log("user_id:", user.id);
console.log("token_id:", minted.row.id);
console.log("prefix:", minted.row.prefix);
console.log("raw_token:", minted.raw);
process.exit(0);
