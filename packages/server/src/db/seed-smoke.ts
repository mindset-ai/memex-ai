// spec-156 verify — provision the post-deploy smoke fixture (b-70 t-9).
//
// Usage (against a live env's Cloud SQL via cloud-sql-proxy):
//   DATABASE_URL=postgresql://… AUTH_JWT_SECRET=… tsx src/db/seed-smoke.ts
//
// Idempotent: re-running is safe. The script ensures:
//   1. User `smoke-probe@memex.ai` exists (verified, active).
//   2. Namespace `zzz-smoke` (kind=user, owned by the smoke user) with a
//      `main` Memex — the throwaway tenant the authed smoke tier writes into
//      (SMOKE_NAMESPACE guard in bus-relay.smoke.test.ts requires "smoke" in
//      the slug, so writes can never target a real tenant).
//   3. A fresh mxt_ PAT minted for the smoke user (printed) → SMOKE_MCP_TOKEN.
//   4. A session JWT signed for the smoke user (printed) → SMOKE_SESSION_TOKEN.
//      The SSE routes sit behind sessionMiddleware (JWT-only — mxt_ tokens are
//      /mcp-only), so the e2e tier needs both credentials. Requires
//      AUTH_JWT_SECRET to match the target env (Secret Manager: auth-jwt-secret).
//
// Store both printed tokens as GitHub environment secrets (int / prod) so the
// deploy-tail smoke runs the authed tier. The session token expires — re-run
// this script to rotate (default TTL 180 days).

import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, and } from "drizzle-orm";
import * as schema from "./schema.js";
import { namespaces, memexes, users } from "./schema.js";
import { mintMcpToken } from "../services/mcp-tokens.js";
import { signSessionToken } from "../services/auth-jwt.js";

const SMOKE_EMAIL = "smoke-probe@memex.ai";
const SMOKE_NAMESPACE_SLUG = "zzz-smoke";
const SMOKE_MEMEX_SLUG = "main";
const SESSION_TTL_SECONDS = 180 * 24 * 60 * 60; // 180 days — rotate by re-running.

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  if (!process.env.AUTH_JWT_SECRET) {
    throw new Error(
      "AUTH_JWT_SECRET is required — the printed session token must verify on the target env " +
        "(Secret Manager: auth-jwt-secret). Refusing to sign with the dev fallback.",
    );
  }
  const client = postgres(connectionString);
  const db = drizzle(client, { schema });

  console.log("Seeding smoke fixture…");

  // ── 1. User ─────────────────────────────────────────────────────────
  let user = await db.query.users.findFirst({ where: eq(users.email, SMOKE_EMAIL) });
  if (!user) {
    [user] = await db
      .insert(users)
      .values({
        email: SMOKE_EMAIL,
        name: "Smoke probe",
        emailVerifiedAt: new Date(),
      } as typeof users.$inferInsert)
      .returning();
    console.log(`  Created user ${user.id} <${SMOKE_EMAIL}>`);
  } else {
    console.log(`  User exists: ${user.id} <${SMOKE_EMAIL}>`);
  }

  // ── 2. Throwaway namespace + Memex ──────────────────────────────────
  let ns = await db.query.namespaces.findFirst({
    where: eq(namespaces.slug, SMOKE_NAMESPACE_SLUG),
  });
  if (!ns) {
    [ns] = await db
      .insert(namespaces)
      .values({ slug: SMOKE_NAMESPACE_SLUG, kind: "user", ownerUserId: user.id })
      .returning();
    console.log(`  Created namespace ${SMOKE_NAMESPACE_SLUG}`);
  }

  // Point the user's personal namespace at zzz-smoke so the session
  // middleware's lazy ensureUserNamespace() never provisions a second one.
  if (user.namespaceId !== ns.id) {
    await db.update(users).set({ namespaceId: ns.id }).where(eq(users.id, user.id));
    console.log(`  Linked user.namespaceId → ${SMOKE_NAMESPACE_SLUG}`);
  }

  let memex = await db.query.memexes.findFirst({
    where: and(eq(memexes.namespaceId, ns.id), eq(memexes.slug, SMOKE_MEMEX_SLUG)),
  });
  if (!memex) {
    [memex] = await db
      .insert(memexes)
      .values({ namespaceId: ns.id, slug: SMOKE_MEMEX_SLUG, name: "Smoke" })
      .returning();
    console.log(`  Created memex ${SMOKE_NAMESPACE_SLUG}/${SMOKE_MEMEX_SLUG}`);
  }

  // ── 3. mxt_ PAT (for /mcp) ──────────────────────────────────────────
  const minted = await mintMcpToken(user.id, "post-deploy smoke (spec-156 ac-13)");

  // ── 4. Session JWT (for the SSE routes) ─────────────────────────────
  const sessionToken = signSessionToken(user.id, SESSION_TTL_SECONDS);

  console.log("\nDone. Provision these as GitHub environment secrets:\n");
  console.log(`  SMOKE_MCP_TOKEN=${minted.raw}`);
  console.log(`  SMOKE_SESSION_TOKEN=${sessionToken}`);
  console.log(`\n  (session token TTL ${SESSION_TTL_SECONDS / 86400} days — re-run to rotate)`);

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
