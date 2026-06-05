// E2E fixtures for the doc-16 Playwright journeys.
//
// The legacy e2e helpers (./db.ts, ./fixtures.ts) reference the pre-migration
// `accounts` table and subdomain-based routing — both of which were retired
// by doc-15 and no longer exist on the server. Rather than rewrite the whole
// e2e infrastructure, this file provides a self-contained fixture that seeds
// against the current namespaces/orgs/memexes schema and builds path-based
// tenant URLs (`memex.ai/<namespace>/<memex>/...`).
//
// Each test owns its own namespace + org + memex; the fixture cleans them up
// in afterEach. The dev user (dev@memex.ai) is enrolled as administrator on
// the test org so the React UI's AuthContext (dev-mode bootstrap) and the
// path-based tenant resolver both accept the test routes.

import { test as base } from "@playwright/test";
import postgres from "postgres";

const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/memex";

function uniqueSlug(prefix: string): string {
  const tail = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  return `${prefix}-${tail}`.toLowerCase().slice(0, 39);
}

export interface SeededTenant {
  /** Namespace slug appears in the URL: /<namespace>/<memex>/... */
  namespaceSlug: string;
  memexSlug: string;
  namespaceId: string;
  orgId: string;
  memexId: string;
  devUserId: string;
}

export interface SeededDoc {
  docId: string;
  handle: string;
  sectionId: string;
}

export interface ReactivityResources {
  /** Tenants seeded in this test; cleaned up automatically. */
  tenants: SeededTenant[];
  seedTenant: (prefix: string) => Promise<SeededTenant>;
  /** Seeds a `docType='spec'` document. */
  seedSpec: (memexId: string, title: string, purpose?: string) => Promise<SeededDoc>;
  seedStandard: (
    memexId: string,
    title: string,
    body?: string,
  ) => Promise<SeededDoc>;
}

async function ensureDevUser(sql: postgres.Sql): Promise<{ userId: string; namespaceId: string }> {
  // dev@memex.ai is the default identity used by the dev-mode AuthContext.
  // Reuse if it exists; create with its own namespace if not. We unconditionally
  // patch `name` and `email_verified_at` because /api/auth/me derives
  // `needsOnboarding` from !user.name — without a name the AppShell renders
  // the Onboarding gate instead of the tenant route, and the Playwright tests
  // fail with a "What's your name?" screen.
  const [existing] = await sql<{ id: string; namespace_id: string | null }[]>`
    SELECT id, namespace_id FROM users WHERE email = 'dev@memex.ai' LIMIT 1
  `;
  if (existing?.id && existing.namespace_id) {
    await sql`
      UPDATE users
      SET
        name = COALESCE(NULLIF(name, ''), 'Dev User'),
        email_verified_at = COALESCE(email_verified_at, now())
      WHERE id = ${existing.id}
    `;
    return { userId: existing.id, namespaceId: existing.namespace_id };
  }

  // Create the user with its own namespace + personal memex.
  return await sql.begin(async (tx) => {
    const userId = existing?.id ?? (await tx<{ id: string }[]>`
      INSERT INTO users (email, name, status, email_verified_at)
      VALUES ('dev@memex.ai', 'Dev User', 'active', now())
      RETURNING id
    `)[0].id;

    if (existing?.id) {
      // User row already existed but had no namespace — patch name/verified
      // there too so the Onboarding gate doesn't fire on re-runs.
      await tx`
        UPDATE users
        SET
          name = COALESCE(NULLIF(name, ''), 'Dev User'),
          email_verified_at = COALESCE(email_verified_at, now())
        WHERE id = ${userId}
      `;
    }

    const userSlug = uniqueSlug("dev");
    const [ns] = await tx<{ id: string }[]>`
      INSERT INTO namespaces (slug, kind, owner_user_id)
      VALUES (${userSlug}, 'user', ${userId})
      RETURNING id
    `;

    await tx`UPDATE users SET namespace_id = ${ns.id} WHERE id = ${userId}`;

    // Personal memex
    await tx`
      INSERT INTO memexes (namespace_id, slug, name)
      VALUES (${ns.id}, 'personal', 'Personal')
      ON CONFLICT DO NOTHING
    `;

    return { userId, namespaceId: ns.id };
  });
}

async function seedTenantImpl(sql: postgres.Sql, prefix: string): Promise<SeededTenant> {
  const namespaceSlug = uniqueSlug(prefix);
  const memexSlug = "main";

  const dev = await ensureDevUser(sql);

  const result = await sql.begin(async (tx) => {
    const [ns] = await tx<{ id: string }[]>`
      INSERT INTO namespaces (slug, kind)
      VALUES (${namespaceSlug}, 'org')
      RETURNING id
    `;
    const [org] = await tx<{ id: string }[]>`
      INSERT INTO orgs (namespace_id, name)
      VALUES (${ns.id}, ${`Test ${prefix}`})
      RETURNING id
    `;
    await tx`UPDATE namespaces SET owner_org_id = ${org.id} WHERE id = ${ns.id}`;

    const [memex] = await tx<{ id: string }[]>`
      INSERT INTO memexes (namespace_id, slug, name)
      VALUES (${ns.id}, ${memexSlug}, 'Main')
      RETURNING id
    `;

    await tx`
      INSERT INTO org_memberships (user_id, org_id, role, status)
      VALUES (${dev.userId}, ${org.id}, 'administrator', 'active')
      ON CONFLICT DO NOTHING
    `;

    return { ns, org, memex };
  });

  return {
    namespaceSlug,
    memexSlug,
    namespaceId: result.ns.id,
    orgId: result.org.id,
    memexId: result.memex.id,
    devUserId: dev.userId,
  };
}

async function seedSpecImpl(
  sql: postgres.Sql,
  memexId: string,
  title: string,
  purpose: string,
): Promise<SeededDoc> {
  return await sql.begin(async (tx) => {
    const [doc] = await tx<{ id: string; handle: string }[]>`
      INSERT INTO documents (memex_id, handle, title, doc_type, status)
      VALUES (${memexId}, 'spec-1', ${title}, 'spec', 'draft')
      RETURNING id, handle
    `;

    const [section] = await tx<{ id: string }[]>`
      INSERT INTO doc_sections (doc_id, section_type, title, content, seq)
      VALUES (${doc.id}, 'overview', 'Overview', ${purpose}, 1)
      RETURNING id
    `;

    return { docId: doc.id, handle: doc.handle, sectionId: section.id };
  });
}

async function seedStandardImpl(
  sql: postgres.Sql,
  memexId: string,
  title: string,
  body: string,
): Promise<SeededDoc> {
  return await sql.begin(async (tx) => {
    const [doc] = await tx<{ id: string; handle: string }[]>`
      INSERT INTO documents (memex_id, handle, title, doc_type, status)
      VALUES (${memexId}, 'std-1', ${title}, 'standard', 'draft')
      RETURNING id, handle
    `;

    const [section] = await tx<{ id: string }[]>`
      INSERT INTO doc_sections (doc_id, section_type, title, content, seq)
      VALUES (${doc.id}, 'rule', 'Rule', ${body}, 1)
      RETURNING id
    `;

    return { docId: doc.id, handle: doc.handle, sectionId: section.id };
  });
}

export const test = base.extend<{ resources: ReactivityResources }>({
  // eslint-disable-next-line no-empty-pattern
  resources: async ({}, use) => {
    const sql = postgres(DATABASE_URL);
    const tenants: SeededTenant[] = [];
    const resources: ReactivityResources = {
      tenants,
      seedTenant: async (prefix) => {
        const t = await seedTenantImpl(sql, prefix);
        tenants.push(t);
        return t;
      },
      seedSpec: (memexId, title, purpose = "Spec purpose.") =>
        seedSpecImpl(sql, memexId, title, purpose),
      seedStandard: (memexId, title, body = "Standard body.") =>
        seedStandardImpl(sql, memexId, title, body),
    };

    await use(resources);

    // Cleanup: delete the test namespaces; FK cascades take down org + memex + docs.
    for (const t of tenants) {
      await sql`DELETE FROM namespaces WHERE id = ${t.namespaceId}`.catch(() => {});
    }
    await sql.end();
  },
});

export { expect } from "@playwright/test";

/** Build a path-based tenant URL: `http://localhost:5173/<namespace>/<memex>/<suffix>`. */
export function tenantPath(t: SeededTenant, suffix: string = ""): string {
  const base = process.env.E2E_BASE_URL ?? "http://localhost:5173";
  const clean = suffix.replace(/^\//, "");
  return `${base}/${t.namespaceSlug}/${t.memexSlug}${clean ? "/" + clean : ""}`;
}

/** Build a path-based API URL for the test server. */
export function tenantApiUrl(t: SeededTenant, suffix: string): string {
  const apiPort = process.env.E2E_SERVER_PORT ?? "8090";
  const clean = suffix.replace(/^\//, "");
  return `http://localhost:${apiPort}/api/${t.namespaceSlug}/${t.memexSlug}/${clean}`;
}

/** Flat API URL (UUID-keyed lookups, std-5 exemption). */
export function flatApiUrl(suffix: string): string {
  const apiPort = process.env.E2E_SERVER_PORT ?? "8090";
  const clean = suffix.replace(/^\//, "");
  return `http://localhost:${apiPort}/api/${clean}`;
}
