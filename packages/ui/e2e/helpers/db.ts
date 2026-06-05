// E2E DB helpers: seed accounts/users/memberships directly so Playwright tests can set up
// multi-user scenarios without going through the UI. Uses raw SQL via `postgres` so the
// admin package needs no drizzle/ORM deps.

import postgres from "postgres";

const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/memex";

const client = postgres(DATABASE_URL);

// Raw SQL helpers — avoid needing to mirror the full schema here. All IDs are UUIDs; all
// timestamps are `now()` by default. Cleanup uses `DELETE FROM accounts WHERE id IN (...)`
// which cascades to memberships, docs, invites, etc. per the FK constraints.

export async function seedAccount(opts: {
  name?: string;
  subdomain: string;
  emailDomains?: string[];
  autoGroupingEnabled?: boolean;
}): Promise<string> {
  const { subdomain, name = subdomain, emailDomains = [], autoGroupingEnabled = false } = opts;
  const rows = await client<{ id: string }[]>`
    INSERT INTO accounts (name, subdomain, email_domains, auto_grouping_enabled)
    VALUES (${name}, ${subdomain}, ${JSON.stringify(emailDomains)}::jsonb, ${autoGroupingEnabled})
    RETURNING id
  `;
  return rows[0].id;
}

export async function seedUser(email: string, name?: string): Promise<string> {
  const rows = await client<{ id: string }[]>`
    INSERT INTO users (email, name)
    VALUES (${email}, ${name ?? null})
    ON CONFLICT (email) DO UPDATE SET updated_at = now(), name = COALESCE(${name ?? null}, users.name)
    RETURNING id
  `;
  const userId = rows[0].id;
  // GitHub-style: every user has a personal memex. Mirror the server-side invariant in tests
  // so session middleware's personal-default resolution works for bare-domain test paths.
  await ensurePersonalAccount(userId);
  return userId;
}

// Idempotent replica of packages/server/src/services/personal-accounts.ts#ensurePersonalAccount,
// implemented in raw SQL so tests can provision personal memexes without booting the server.
export async function ensurePersonalAccount(userId: string): Promise<string> {
  const existing = await client<{ personal_account_id: string | null }[]>`
    SELECT personal_account_id FROM users WHERE id = ${userId} LIMIT 1
  `;
  if (existing[0]?.personal_account_id) {
    const accountRows = await client<{ id: string }[]>`
      SELECT id FROM accounts WHERE id = ${existing[0].personal_account_id} LIMIT 1
    `;
    if (accountRows[0]) return accountRows[0].id;
    // Dangling FK — fall through and recreate.
  }

  const subdomain = `personal-${userId}`;
  const accountRows = await client<{ id: string }[]>`
    INSERT INTO accounts (name, subdomain, kind)
    VALUES ('Personal Memex', ${subdomain}, 'personal')
    ON CONFLICT (subdomain) DO UPDATE SET subdomain = EXCLUDED.subdomain
    RETURNING id
  `;
  const accountId = accountRows[0].id;
  await client`
    INSERT INTO account_memberships (user_id, account_id, role, status)
    VALUES (${userId}, ${accountId}, 'administrator', 'active')
    ON CONFLICT (user_id, account_id) DO UPDATE SET status = 'active', role = 'administrator'
  `;
  await client`
    UPDATE users SET personal_account_id = ${accountId}, updated_at = now() WHERE id = ${userId}
  `;
  return accountId;
}

export async function seedMembership(
  userId: string,
  accountId: string,
  role: "user" | "administrator" = "administrator"
): Promise<void> {
  await client`
    INSERT INTO account_memberships (user_id, account_id, role)
    VALUES (${userId}, ${accountId}, ${role})
    ON CONFLICT (user_id, account_id) DO UPDATE SET role = ${role}, status = 'active'
  `;
}

export async function seedDoc(opts: {
  accountId: string;
  handle: string;
  title: string;
  purpose?: string;
  docType?: "spec" | "standard" | "document" | "execution_plan" | "guide" | "plan";
}): Promise<{ docId: string; sectionId: string }> {
  const { accountId, handle, title, purpose = "Test purpose", docType = "spec" } = opts;
  const doc = await client<{ id: string }[]>`
    INSERT INTO documents (account_id, handle, title, doc_type, status)
    VALUES (${accountId}, ${handle}, ${title}, ${docType}, 'draft')
    RETURNING id
  `;
  const section = await client<{ id: string }[]>`
    INSERT INTO doc_sections (doc_id, section_type, title, content, seq)
    VALUES (${doc[0].id}, 'purpose', 'Purpose', ${purpose}, 1)
    RETURNING id
  `;
  return { docId: doc[0].id, sectionId: section[0].id };
}

export async function seedSection(opts: {
  docId: string;
  title: string;
  content?: string;
  seq: number;
  sectionType?: string;
}): Promise<string> {
  const { docId, title, content = "", seq, sectionType = "context" } = opts;
  const rows = await client<{ id: string }[]>`
    INSERT INTO doc_sections (doc_id, section_type, title, content, seq)
    VALUES (${docId}, ${sectionType}, ${title}, ${content}, ${seq})
    RETURNING id
  `;
  return rows[0].id;
}

// ── Post-0038 memex-native seeding (spec-64 journey-18) ──────────────────────
// The legacy seedAccount/seedDoc helpers above target the pre-0038 `accounts`
// schema. The split-out tenancy model (migration 0038) routes by
// `<namespace>/<memex>` and scopes docs by `memex_id`, so the global-search
// journey seeds straight into a memex. These helpers mirror the server's own
// row shapes (documents + doc_sections); `content_tsv` is a STORED GENERATED
// column, so a seeded purpose section is immediately FTS-matchable without an
// embedding provider (search falls back to FTS-only, ac-11).

// Resolve the personal memex of a user (by email) — the workspace the dev
// session lands in. Returns { memexId, namespaceSlug, memexSlug } so the test
// can both seed into the memex AND assert the canonical `/ns/mx/...` path the
// search route builds. dev@memex.ai resolves to namespace `dev` / memex
// `personal` after the 0038 migration backfill.
export async function getPersonalMemexByEmail(
  email: string
): Promise<{ memexId: string; namespaceSlug: string; memexSlug: string } | null> {
  const rows = await client<
    { memex_id: string; namespace_slug: string; memex_slug: string }[]
  >`
    SELECT m.id AS memex_id, n.slug AS namespace_slug, m.slug AS memex_slug
    FROM users u
    INNER JOIN namespaces n ON n.id = u.namespace_id
    INNER JOIN memexes m ON m.namespace_id = n.id
    WHERE u.email = ${email}
    ORDER BY m.created_at ASC
    LIMIT 1
  `;
  const r = rows[0];
  return r
    ? { memexId: r.memex_id, namespaceSlug: r.namespace_slug, memexSlug: r.memex_slug }
    : null;
}

// Ensure a user has a display name so the app skips the onboarding profile-setup
// screen and routes straight to the tenant. The server's dev-user bypass creates
// dev@memex.ai WITHOUT a name (→ Onboarding), and the shared account-based fixture
// that normally sets it (`seedUser`) writes to the pre-0038 `personal_account_id`
// schema and throws — so this is the schema-current path.
export async function setUserName(email: string, name: string): Promise<void> {
  await client`UPDATE users SET name = ${name}, updated_at = now() WHERE email = ${email}`;
}

// Seed a Spec (documents row + a purpose doc_sections row) into a memex by id.
// Returns the docId so the test can clean it up. `handle` lands the spec at
// `/<ns>/<mx>/specs/<handle>` (the SpecList → DocDocument route). The purpose
// section's `content` feeds the generated `content_tsv`, so the spec is found
// by both the jumpTo title-substring arm (ac-18) and the content FTS arm.
export async function seedSpecInMemex(opts: {
  memexId: string;
  handle: string;
  title: string;
  purpose?: string;
}): Promise<{ docId: string }> {
  const { memexId, handle, title, purpose = "Seeded purpose for the search journey." } = opts;
  const doc = await client<{ id: string }[]>`
    INSERT INTO documents (memex_id, handle, title, doc_type, status)
    VALUES (${memexId}, ${handle}, ${title}, 'spec', 'draft')
    RETURNING id
  `;
  await client`
    INSERT INTO doc_sections (doc_id, section_type, title, content, seq, status)
    VALUES (${doc[0].id}, 'purpose', 'Purpose', ${purpose}, 1, 'active')
  `;
  return { docId: doc[0].id };
}

// Drop a seeded doc by id (cascades to its sections). Used by the journey's
// afterEach so the dev memex is left clean between runs.
export async function deleteDoc(docId: string): Promise<void> {
  await client`DELETE FROM documents WHERE id = ${docId}`;
}

export async function deleteAccounts(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await client`DELETE FROM accounts WHERE id = ANY(${ids})`;
}

export async function deleteUsersByEmail(emails: string[]): Promise<void> {
  if (!emails.length) return;
  // Personal accounts aren't tracked in resources.accountIds (they're created implicitly by
  // seedUser), so they won't be caught by deleteAccounts. Drop them here by FK lookup before
  // deleting the user. Deletion cascades to memberships.
  await client`
    DELETE FROM accounts
    WHERE id IN (
      SELECT personal_account_id FROM users
      WHERE email = ANY(${emails}) AND personal_account_id IS NOT NULL
    )
  `;
  await client`DELETE FROM users WHERE email = ANY(${emails})`;
}

export async function getAccountById(id: string): Promise<Record<string, unknown> | null> {
  const rows = await client<Record<string, unknown>[]>`
    SELECT * FROM accounts WHERE id = ${id} LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function listDocsForAccount(accountId: string): Promise<Record<string, unknown>[]> {
  return client<Record<string, unknown>[]>`
    SELECT * FROM documents WHERE account_id = ${accountId} ORDER BY created_at DESC
  `;
}

export async function countAdmins(accountId: string): Promise<number> {
  const rows = await client<{ count: string }[]>`
    SELECT count(*)::text FROM account_memberships
    WHERE account_id = ${accountId} AND role = 'administrator' AND status = 'active'
  `;
  return Number(rows[0].count);
}

export async function getLatestInviteToken(accountId: string): Promise<string | null> {
  // invite_tokens migrated from single-use (`used` boolean) to multi-use
  // (`revoked_at` timestamp) per migration 0024_invite_tokens_multi_use.
  // A non-revoked, non-expired link is valid.
  const rows = await client<{ token: string }[]>`
    SELECT token FROM invite_tokens
    WHERE account_id = ${accountId}
      AND revoked_at IS NULL
      AND expires_at > now()
    ORDER BY created_at DESC LIMIT 1
  `;
  return rows[0]?.token ?? null;
}

export async function getLatestShareToken(docId: string): Promise<string | null> {
  const rows = await client<{ token: string }[]>`
    SELECT token FROM share_tokens
    WHERE document_id = ${docId} AND revoked = false
    ORDER BY created_at DESC LIMIT 1
  `;
  return rows[0]?.token ?? null;
}

export async function setAccountDomainVerified(
  accountId: string,
  domain: string
): Promise<void> {
  await client`
    INSERT INTO verified_domains (domain, account_id, verification_method)
    VALUES (${domain}, ${accountId}, 'email')
    ON CONFLICT (domain) DO UPDATE SET account_id = ${accountId}
  `;
  await client`
    UPDATE accounts SET domain_verified = true WHERE id = ${accountId}
  `;
}

export async function closeDb(): Promise<void> {
  await client.end();
}

export async function clearUserName(email: string): Promise<void> {
  await client`UPDATE users SET name = NULL WHERE email = ${email}`;
}

// Remove TEAM memberships for a given email. Personal memberships are preserved because
// every user has exactly one and wiping it would both break session middleware's personal-
// default resolution and orphan the user's personal_account_id FK. Used by test fixtures to
// reset dev@memex.ai's team-membership state between journeys so stale rows don't alter
// PostLoginRouter's routing decision.
export async function clearMembershipsForEmail(email: string): Promise<void> {
  await client`
    DELETE FROM account_memberships
    WHERE user_id IN (SELECT id FROM users WHERE email = ${email})
      AND account_id IN (SELECT id FROM accounts WHERE kind = 'team')
  `;
}
