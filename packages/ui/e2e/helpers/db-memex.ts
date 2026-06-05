// E2E DB helpers on the CURRENT tenancy schema (namespaces / orgs / memexes /
// org_memberships — std-1), used by the path-based journeys.
//
// The legacy helpers in db.ts still target the pre-spec-15 accounts/subdomain
// schema and no longer run against a migrated DB. Rather than rewrite every
// historical journey, new path-based journeys seed through this module.
//
// Access model (std-4): an active org_memberships row grants write access to
// every memex in that org's namespace (see services/users.ts#listMemberships).
// We seed exactly that for dev@memex.ai — the identity the dev-auth bypass
// resolves every request to when GOOGLE_CLIENT_ID is empty.

import postgres from "postgres";

const DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/memex";

const client = postgres(DATABASE_URL);

const DEV_EMAIL = "dev@memex.ai";

/** Upsert dev@memex.ai and return its user id. */
export async function ensureDevUser(): Promise<string> {
  const rows = await client<{ id: string }[]>`
    INSERT INTO users (email, name, status)
    VALUES (${DEV_EMAIL}, 'Dev User', 'active')
    ON CONFLICT (email) DO UPDATE SET name = COALESCE(users.name, 'Dev User'), status = 'active'
    RETURNING id
  `;
  return rows[0]!.id;
}

export interface SeededMemexDoc {
  namespaceId: string;
  namespaceSlug: string;
  orgId: string;
  memexId: string;
  memexSlug: string;
  docId: string;
}

/**
 * Seed an org-owned namespace + memex with dev@memex.ai as an active
 * administrator, plus one Spec document (no doc_members row, so dev opens it as
 * a REVIEWER — the bug-report starting state). Returns the slugs + ids needed to
 * build the path-based URL and assert against the DB.
 */
export async function seedMemexWithSpec(opts: {
  slug: string; // used for both the namespace and memex slug
  title: string;
  handle?: string;
  purpose?: string;
}): Promise<SeededMemexDoc> {
  const { slug, title, handle = "spec-1", purpose = "Seeded purpose." } = opts;
  const devId = await ensureDevUser();

  const ns = await client<{ id: string }[]>`
    INSERT INTO namespaces (slug, kind) VALUES (${slug}, 'org') RETURNING id
  `;
  const namespaceId = ns[0]!.id;

  const org = await client<{ id: string }[]>`
    INSERT INTO orgs (namespace_id, name, created_by_user_id)
    VALUES (${namespaceId}, ${title + " Org"}, ${devId})
    RETURNING id
  `;
  const orgId = org[0]!.id;
  await client`UPDATE namespaces SET owner_org_id = ${orgId} WHERE id = ${namespaceId}`;

  const memexSlug = slug;
  const mx = await client<{ id: string }[]>`
    INSERT INTO memexes (namespace_id, slug, name, visibility)
    VALUES (${namespaceId}, ${memexSlug}, ${title}, 'private')
    RETURNING id
  `;
  const memexId = mx[0]!.id;

  await client`
    INSERT INTO org_memberships (user_id, org_id, role, status)
    VALUES (${devId}, ${orgId}, 'administrator', 'active')
  `;

  // created_by_user_id is left NULL: seeding directly bypasses createDocDraft's
  // editor seeding, so there is no doc_members row and dev resolves to reviewer.
  const doc = await client<{ id: string }[]>`
    INSERT INTO documents (memex_id, handle, title, doc_type, status)
    VALUES (${memexId}, ${handle}, ${title}, 'spec', 'draft')
    RETURNING id
  `;
  const docId = doc[0]!.id;

  await client`
    INSERT INTO doc_sections (doc_id, section_type, title, content, seq)
    VALUES (${docId}, 'purpose', 'Purpose', ${purpose}, 1)
  `;

  return { namespaceId, namespaceSlug: slug, orgId, memexId, memexSlug, docId };
}

/** Resolve the viewer's role for a (doc, user) straight from the DB. */
export async function dbDocRole(docId: string, userId: string): Promise<"editor" | "reviewer"> {
  const rows = await client<{ role: string }[]>`
    SELECT role FROM doc_members WHERE doc_id = ${docId} AND user_id = ${userId} LIMIT 1
  `;
  return rows[0]?.role === "editor" ? "editor" : "reviewer";
}

/** Count assignees on a doc. */
export async function dbAssigneeCount(docId: string): Promise<number> {
  const rows = await client<{ count: string }[]>`
    SELECT count(*)::text FROM doc_assignees WHERE doc_id = ${docId}
  `;
  return Number(rows[0]!.count);
}

/** Tear down a seeded namespace and everything under it. */
export async function dropNamespace(namespaceId: string): Promise<void> {
  // Delete in dependency order; doc_members/doc_assignees cascade from documents.
  await client`
    DELETE FROM documents WHERE memex_id IN (SELECT id FROM memexes WHERE namespace_id = ${namespaceId})
  `;
  await client`
    DELETE FROM org_memberships WHERE org_id IN (SELECT id FROM orgs WHERE namespace_id = ${namespaceId})
  `;
  await client`DELETE FROM memexes WHERE namespace_id = ${namespaceId}`;
  // Break the namespace↔org owner cycle before deleting orgs.
  await client`UPDATE namespaces SET owner_org_id = NULL WHERE id = ${namespaceId}`;
  await client`DELETE FROM orgs WHERE namespace_id = ${namespaceId}`;
  await client`DELETE FROM namespaces WHERE id = ${namespaceId}`;
}

export async function closeMemexDb(): Promise<void> {
  await client.end();
}
