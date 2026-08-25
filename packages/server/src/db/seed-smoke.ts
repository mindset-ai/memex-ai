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
// Store the printed tokens as GitHub environment secrets (int / prod) so the
// deploy-tail smoke runs the authed tier. The session token expires — re-run
// this script to rotate (default TTL 180 days).

import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, and } from "drizzle-orm";
import * as schema from "./schema.js";
import { namespaces, memexes, users, documents, acs } from "./schema.js";
import { runWithMemexId } from "./connection.js";
import { mintMcpToken } from "../services/mcp-tokens.js";
import { signSessionToken } from "../services/auth-jwt.js";
// spec-533 t-4: the warning-header wire probe needs a REAL emission that lands, because
// X-Memex-Warning is set after processOneEvent succeeds — unlike the gate marker, which
// middleware sets ahead of authentication and which therefore needs no credential.
import { mintEmissionKey } from "../services/emission-keys.js";
import { createDocDraft } from "../services/documents.js";
import { createAc } from "../services/acs.js";

const SMOKE_EMAIL = "smoke-probe@memex.ai";
const SMOKE_NAMESPACE_SLUG = "zzz-smoke";
const SMOKE_MEMEX_SLUG = "main";
const SESSION_TTL_SECONDS = 180 * 24 * 60 * 60; // 180 days — rotate by re-running.
// spec-533: the Spec the emission probe targets. Title is the idempotency key — the
// script must be safe to re-run, and re-running must not pile up throwaway Specs.
const SMOKE_PROBE_SPEC_TITLE = "Smoke probe target (spec-533 wire check)";

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

  // ── 5. Spec + AC for the emission probe, and a permanent emission key ───
  //
  // The probe posts a real test-event, so it needs (a) an AC ref its key authorises and
  // (b) a durable key. Both live in the throwaway island — spec-70 dec-2: the smoke suite
  // owns its own data island and MUST NEVER touch a real namespace or memex.
  //
  // A PERMANENT key (expiresAt NULL), not the ephemeral Spec-scoped kind: this is a CI
  // credential, and provision_ac_emission deliberately cannot mint one because a
  // long-lived secret must not round-trip an agent's transcript (spec-234 dec-1/dec-5).
  // Minting it HERE is the same act as a human minting in Settings — the script prints it
  // once into the operator's terminal, exactly as it already does for the PAT above.
  let probeSpec = await db.query.documents.findFirst({
    where: and(
      eq(documents.memexId, memex.id),
      eq(documents.title, SMOKE_PROBE_SPEC_TITLE),
    ),
  });
  if (!probeSpec) {
    // Wrapped in runWithMemexId: documents / doc_members / acs are RLS-gated, and
    // spec-440's guard fires on a context-less write to any of them. This script runs
    // as the table OWNER, which bypasses RLS [per std-36], so the write lands either
    // way — but the guard is right to complain. Cloud Run sets
    // MEMEX_RLS_GUARD_THROW=1, so a context-less write there ABORTS, and under the
    // runtime role it would be silently REJECTED. Relying on "we happen to connect as
    // owner" is exactly the accident this Spec is about.
    const created = await runWithMemexId(memex.id, () =>
      createDocDraft(
        memex.id,
        SMOKE_PROBE_SPEC_TITLE,
        "Target for the post-deploy X-Memex-Warning wire probe (spec-533 ac-18/ac-20). " +
          "Its criterion exists to be emitted against; nothing here is real work.",
        "spec",
        undefined,
        undefined,
        user.id,
      ),
    );
    probeSpec = created;
    console.log(`  Created probe Spec ${probeSpec.handle}`);
  } else {
    console.log(`  Probe Spec exists: ${probeSpec.handle}`);
  }

  let probeAc = await db.query.acs.findFirst({
    where: eq(acs.briefId, probeSpec.id),
  });
  if (!probeAc) {
    probeAc = await runWithMemexId(memex.id, () =>
      createAc({
        memexId: memex.id,
        briefId: probeSpec!.id,
        kind: "scope",
        statement:
          "A custom response header set by /api/test-events reaches an external client " +
          "through the load balancer. Emitted against by the post-deploy wire probe.",
      }),
    );
    console.log(`  Created probe AC ac-${probeAc.seq}`);
  } else {
    console.log(`  Probe AC exists: ac-${probeAc.seq}`);
  }

  const emitKey = await mintEmissionKey(
    memex.id,
    "post-deploy smoke — warning-header wire probe (spec-533 t-4)",
    user.id,
  );
  const probeRef =
    `${SMOKE_NAMESPACE_SLUG}/${SMOKE_MEMEX_SLUG}/specs/${probeSpec.handle}/acs/ac-${probeAc.seq}`;

  console.log("\nDone. Provision these as GitHub environment secrets:\n");
  console.log(`  SMOKE_MCP_TOKEN=${minted.raw}`);
  console.log(`  SMOKE_SESSION_TOKEN=${sessionToken}`);
  console.log(`  SMOKE_EMIT_KEY=${emitKey.raw}`);
  console.log(`  SMOKE_EMIT_AC_REF=${probeRef}`);
  console.log(`\n  (session token TTL ${SESSION_TTL_SECONDS / 86400} days — re-run to rotate)`);
  console.log(
    "  (SMOKE_EMIT_KEY is permanent — re-running mints an ADDITIONAL key rather than\n" +
      "   rotating; revoke the old one in Settings if you replace it)",
  );

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
