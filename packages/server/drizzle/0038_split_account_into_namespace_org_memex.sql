-- Split the legacy `accounts` table into three peer concepts: namespaces,
-- orgs, memexes (and org_memberships). Mission doc-15.
--
-- Decisions (LOCKED): dec-1 hierarchy shape, dec-2 org-level access, dec-3
-- path-based routing, dec-4 v1 visibility scope, dec-5 no-silent-default,
-- dec-9 full rename / no aliases, dec-10 drop referralShareTokenId, dec-11
-- apex/www split.
--
-- Standards: std-1 namespace/org/memex are distinct, std-3 slug allocation,
-- std-4 org membership grants memex access, std-6 disabled members never
-- silently re-enabled.
--
-- This is a DESTRUCTIVE single-shot migration. Pre-launch + internal users
-- only; rollback is restore-from-backup. The hand-migration runner wraps the
-- whole file in a single transaction (--single-transaction) so partial
-- failure rolls back automatically. Per dec-10, accounts.referralShareTokenId
-- is discarded — not carried forward.
--
-- High-level shape:
--   1. Create new tables: namespaces, orgs, memexes, org_memberships.
--   2. Add users.namespace_id (nullable; populated in phase 3).
--   3. For every personal account → 1 namespace (kind=user) + 1 memex.
--      For every team account     → 1 namespace (kind=org) + 1 org + 1 memex.
--      Stash old→new id mapping in _migration_account_to_memex.
--   4. Migrate account_memberships → org_memberships (role 'user' → 'member';
--      status preserved; disabled rows stay disabled per std-6).
--   5. Per tenancy table (documents, doc_comments, decisions, tasks, repos):
--      add memex_id, populate, drop account_id + dependent constraints,
--      re-add unique/index/FK on memex_id.
--   6. Per org-scoped table (invite_tokens, verified_domains,
--      domain_verification_tokens): rename account_id → org_id with new FK.
--   7. Drop users.personal_account_id, drop accounts + account_memberships.
--   8. Re-add the deferred owner_xor CHECK on namespaces (skipped during data
--      load because team namespaces are inserted before their org row exists).

-- ─── Phase 1: New tables ─────────────────────────────────────────────

CREATE TABLE "namespaces" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "slug" text NOT NULL,
  "kind" text NOT NULL,
  -- Owner FKs are populated below; the XOR constraint is added at the END
  -- of this migration (a team namespace is inserted before its org exists).
  "owner_user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE,
  "owner_org_id" uuid,  -- FK added once `orgs` exists.
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "namespaces_slug_unique" UNIQUE ("slug"),
  CONSTRAINT "namespaces_kind_valid" CHECK ("kind" IN ('user', 'org')),
  -- Slug regex per std-3: lowercase alphanumeric + hyphens, alnum start, ≤39.
  CONSTRAINT "namespaces_slug_format" CHECK ("slug" ~ '^[a-z0-9][a-z0-9-]{0,38}$')
);
--> statement-breakpoint
CREATE INDEX "namespaces_owner_user_id_idx" ON "namespaces" ("owner_user_id");
--> statement-breakpoint
CREATE INDEX "namespaces_owner_org_id_idx" ON "namespaces" ("owner_org_id");
--> statement-breakpoint

CREATE TABLE "orgs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "namespace_id" uuid NOT NULL,
  "name" text NOT NULL,
  -- Domain-discovery state carried forward from accounts.
  "email_domains" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "auto_grouping_enabled" boolean NOT NULL DEFAULT false,
  "domain_verified" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  -- referralShareTokenId NOT carried forward (dec-10).
  CONSTRAINT "orgs_namespace_id_unique" UNIQUE ("namespace_id"),
  CONSTRAINT "orgs_namespace_id_namespaces_id_fk"
    FOREIGN KEY ("namespace_id") REFERENCES "namespaces"("id") ON DELETE CASCADE
);
--> statement-breakpoint

-- Now that `orgs` exists, wire up namespaces.owner_org_id as a real FK.
ALTER TABLE "namespaces" ADD CONSTRAINT "namespaces_owner_org_id_orgs_id_fk"
  FOREIGN KEY ("owner_org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
--> statement-breakpoint

CREATE TABLE "memexes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "namespace_id" uuid NOT NULL,
  -- Slug is unique per namespace, not globally — same name lives fine in
  -- different namespaces (e.g. <user>/notes and <org>/notes).
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "memexes_slug_format" CHECK ("slug" ~ '^[a-z0-9][a-z0-9-]{0,38}$'),
  CONSTRAINT "memexes_namespace_id_slug_unique" UNIQUE ("namespace_id", "slug"),
  CONSTRAINT "memexes_namespace_id_namespaces_id_fk"
    FOREIGN KEY ("namespace_id") REFERENCES "namespaces"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX "memexes_namespace_id_idx" ON "memexes" ("namespace_id");
--> statement-breakpoint

CREATE TABLE "org_memberships" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL,
  "org_id" uuid NOT NULL,
  "role" text NOT NULL,
  -- Disabled rows are retained for attribution; never silently re-activated
  -- through any code path (std-6).
  "status" text NOT NULL DEFAULT 'active',
  "joined_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "org_memberships_user_id_org_id_unique" UNIQUE ("user_id", "org_id"),
  -- Roles renamed from legacy ('user','administrator') to ('member','administrator')
  -- per F.6 of the mission. The data move (phase 4) translates 'user' → 'member'.
  CONSTRAINT "org_memberships_role_valid" CHECK ("role" IN ('member', 'administrator')),
  CONSTRAINT "org_memberships_status_valid" CHECK ("status" IN ('active', 'disabled')),
  CONSTRAINT "org_memberships_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "org_memberships_org_id_orgs_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX "org_memberships_user_id_idx" ON "org_memberships" ("user_id");
--> statement-breakpoint
CREATE INDEX "org_memberships_org_id_idx" ON "org_memberships" ("org_id");
--> statement-breakpoint

-- ─── Phase 2: users.namespace_id (nullable for now) ──────────────────

ALTER TABLE "users" ADD COLUMN "namespace_id" uuid;
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_namespace_id_namespaces_id_fk"
  FOREIGN KEY ("namespace_id") REFERENCES "namespaces"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_namespace_id_unique" UNIQUE ("namespace_id");
--> statement-breakpoint

-- ─── Phase 3: Migrate accounts → namespaces (+ orgs) + memexes ───────
-- Stash old→new id mapping in a temp-ish table so phase 5/6 joins are simple.

CREATE TABLE "_migration_account_to_memex" (
  "account_id" uuid PRIMARY KEY,
  "memex_id" uuid NOT NULL,
  "org_id" uuid  -- NULL for personal accounts (no org)
);
--> statement-breakpoint

DO $$
DECLARE
  -- Reserved-list per std-3 (final form per dec-11 — apex/www split shrinks
  -- the list to app-utility paths only). Marketing terms live on www. and
  -- are NOT reserved at the slug level.
  RESERVED_SLUGS text[] := ARRAY[
    'login','signup','install','install.sh','install.ps1','api','auth',
    'health','share','settings','me','mcp','admin','account','app','docs',
    'support','help','memex'
  ];
  acct RECORD;
  user_row RECORD;
  base_slug text;
  candidate text;
  attempt integer;
  ns_id uuid;
  org_uuid uuid;
  mx_id uuid;
BEGIN
  -- Personal accounts → user namespace + 1 memex per std-3 (slug derived
  -- from email local-part, editable later via settings — for the migration
  -- we sanitise + collision-resolve).
  --
  -- Resolve user via either path: (a) users.personal_account_id FK (the
  -- post-0021 path) or (b) the legacy `personal-<userId>` subdomain
  -- sentinel. Some dev databases have orphan personal accounts whose owning
  -- user was deleted — those are dropped at the end of phase 3 along with
  -- any tenancy data they hold. (Pre-launch + internal-only license per the
  -- mission rollback policy.)
  FOR user_row IN
    SELECT
      COALESCE(u_via_fk.id, u_via_subdomain.id) AS user_id,
      COALESCE(u_via_fk.email, u_via_subdomain.email) AS email,
      a.id AS account_id,
      a.name AS account_name
    FROM accounts a
    LEFT JOIN users u_via_fk ON u_via_fk.personal_account_id = a.id
    LEFT JOIN users u_via_subdomain
      ON 'personal-' || u_via_subdomain.id::text = a.subdomain
    WHERE a.kind = 'personal'
      AND COALESCE(u_via_fk.id, u_via_subdomain.id) IS NOT NULL
    ORDER BY a.created_at ASC
  LOOP
    -- Sanitise local-part: lowercase, replace non-[a-z0-9] with '-', collapse
    -- runs, trim leading/trailing '-', cap at 39 chars.
    base_slug := lower(split_part(user_row.email, '@', 1));
    base_slug := regexp_replace(base_slug, '[^a-z0-9-]+', '-', 'g');
    base_slug := regexp_replace(base_slug, '-+', '-', 'g');
    base_slug := trim(both '-' from base_slug);
    base_slug := substr(base_slug, 1, 39);

    -- Fallback if sanitisation left it empty / reserved / shape-invalid
    -- (e.g. starts with hyphen or non-alnum after trim).
    IF base_slug = '' OR base_slug = ANY(RESERVED_SLUGS)
       OR base_slug !~ '^[a-z0-9][a-z0-9-]{0,38}$' THEN
      base_slug := 'user-' || substr(user_row.user_id::text, 1, 8);
    END IF;

    -- Collision-resolve. The reserved-list check above prevents 'admin' etc.
    -- so the loop only runs for genuine slug collisions across users.
    candidate := base_slug;
    attempt := 1;
    WHILE EXISTS (SELECT 1 FROM namespaces WHERE slug = candidate) LOOP
      attempt := attempt + 1;
      candidate := substr(base_slug, 1, 39 - length('-' || attempt::text)) || '-' || attempt::text;
    END LOOP;

    INSERT INTO namespaces (slug, kind, owner_user_id)
    VALUES (candidate, 'user', user_row.user_id)
    RETURNING id INTO ns_id;

    -- Default Memex slug. The legacy "Personal Memex" name carries forward
    -- so the user sees the same workspace name post-migration.
    INSERT INTO memexes (namespace_id, slug, name)
    VALUES (ns_id, 'personal', COALESCE(NULLIF(user_row.account_name, ''), 'Personal'))
    RETURNING id INTO mx_id;

    UPDATE users SET namespace_id = ns_id WHERE id = user_row.user_id;

    INSERT INTO _migration_account_to_memex (account_id, memex_id, org_id)
    VALUES (user_row.account_id, mx_id, NULL);
  END LOOP;

  -- Team accounts → org namespace + org + 1 memex.
  FOR acct IN
    SELECT id, name, subdomain, email_domains, auto_grouping_enabled, domain_verified
    FROM accounts
    WHERE kind = 'team'
    ORDER BY created_at ASC
  LOOP
    -- Existing subdomain becomes the org's namespace slug. Sanitise to the
    -- new (tighter) format; bump on collision; reserved-list collision
    -- demotes to the org-<id> fallback.
    base_slug := lower(acct.subdomain);
    base_slug := regexp_replace(base_slug, '[^a-z0-9-]+', '-', 'g');
    base_slug := regexp_replace(base_slug, '-+', '-', 'g');
    base_slug := trim(both '-' from base_slug);
    base_slug := substr(base_slug, 1, 39);

    IF base_slug = '' OR base_slug = ANY(RESERVED_SLUGS)
       OR base_slug !~ '^[a-z0-9][a-z0-9-]{0,38}$' THEN
      base_slug := 'org-' || substr(acct.id::text, 1, 8);
    END IF;

    candidate := base_slug;
    attempt := 1;
    WHILE EXISTS (SELECT 1 FROM namespaces WHERE slug = candidate) LOOP
      attempt := attempt + 1;
      candidate := substr(base_slug, 1, 39 - length('-' || attempt::text)) || '-' || attempt::text;
    END LOOP;

    -- Insert namespace first (owner_org_id NULL for now), then org, then
    -- back-fill the namespace's owner pointer. The owner_xor CHECK is added
    -- at the end of this migration so the in-flight NULL is allowed.
    INSERT INTO namespaces (slug, kind, owner_user_id, owner_org_id)
    VALUES (candidate, 'org', NULL, NULL)
    RETURNING id INTO ns_id;

    INSERT INTO orgs (namespace_id, name, email_domains, auto_grouping_enabled, domain_verified)
    VALUES (ns_id, acct.name, acct.email_domains, acct.auto_grouping_enabled, acct.domain_verified)
    RETURNING id INTO org_uuid;

    UPDATE namespaces SET owner_org_id = org_uuid WHERE id = ns_id;

    -- v0 had one workspace per team account, so the migration produces N=1
    -- memexes per org. The team's existing name carries forward.
    INSERT INTO memexes (namespace_id, slug, name)
    VALUES (ns_id, 'main', acct.name)
    RETURNING id INTO mx_id;

    INSERT INTO _migration_account_to_memex (account_id, memex_id, org_id)
    VALUES (acct.id, mx_id, org_uuid);
  END LOOP;

  -- Safety net: any users without a personal_account_id (edge case from
  -- 0021's pre-backfill window) still need a namespace, otherwise the
  -- final SET NOT NULL on users.namespace_id fails. Create one from email.
  FOR user_row IN
    SELECT id AS user_id, email FROM users WHERE namespace_id IS NULL
  LOOP
    base_slug := lower(split_part(user_row.email, '@', 1));
    base_slug := regexp_replace(base_slug, '[^a-z0-9-]+', '-', 'g');
    base_slug := regexp_replace(base_slug, '-+', '-', 'g');
    base_slug := trim(both '-' from base_slug);
    base_slug := substr(base_slug, 1, 39);
    IF base_slug = '' OR base_slug = ANY(RESERVED_SLUGS)
       OR base_slug !~ '^[a-z0-9][a-z0-9-]{0,38}$' THEN
      base_slug := 'user-' || substr(user_row.user_id::text, 1, 8);
    END IF;
    candidate := base_slug;
    attempt := 1;
    WHILE EXISTS (SELECT 1 FROM namespaces WHERE slug = candidate) LOOP
      attempt := attempt + 1;
      candidate := substr(base_slug, 1, 39 - length('-' || attempt::text)) || '-' || attempt::text;
    END LOOP;

    INSERT INTO namespaces (slug, kind, owner_user_id)
    VALUES (candidate, 'user', user_row.user_id)
    RETURNING id INTO ns_id;

    INSERT INTO memexes (namespace_id, slug, name)
    VALUES (ns_id, 'personal', 'Personal');

    UPDATE users SET namespace_id = ns_id WHERE id = user_row.user_id;
  END LOOP;
END $$;
--> statement-breakpoint

-- Drop orphan accounts that didn't map (no resolvable user, or any other
-- pathological case). Existing FK ON DELETE CASCADE on every tenancy table
-- (per migration 0014) means dependent rows in documents, decisions, tasks,
-- doc_comments etc. are removed in the same statement — Phase 5 will only
-- see well-formed rows.
DELETE FROM "accounts"
WHERE "id" NOT IN (SELECT "account_id" FROM "_migration_account_to_memex");
--> statement-breakpoint

-- ─── Phase 4: account_memberships → org_memberships ──────────────────
-- Personal accounts have a self-membership row that doesn't migrate (a user
-- is their own namespace owner, not a "member" of themselves). Team rows
-- copy through with role 'user' → 'member' and status preserved.

INSERT INTO org_memberships (user_id, org_id, role, status, joined_at)
SELECT
  am.user_id,
  m.org_id,
  CASE WHEN am.role = 'user' THEN 'member' ELSE am.role END,
  am.status,
  am.joined_at
FROM account_memberships am
JOIN _migration_account_to_memex m ON m.account_id = am.account_id
WHERE m.org_id IS NOT NULL  -- skip personal accounts (no org concept)
ON CONFLICT (user_id, org_id) DO NOTHING;
--> statement-breakpoint

-- ─── Phase 5: Tenancy tables — account_id → memex_id ─────────────────
-- Pattern per table: add nullable memex_id, populate from the migration map,
-- set NOT NULL, drop old column with CASCADE (which removes the legacy FK,
-- index, and any (account_id, …) unique constraint), re-add new constraints.

-- documents ──────────────────────────────────────────────────────────
ALTER TABLE "documents" ADD COLUMN "memex_id" uuid;
--> statement-breakpoint
UPDATE "documents" d SET "memex_id" = m.memex_id
  FROM "_migration_account_to_memex" m WHERE m.account_id = d.account_id;
--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "memex_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_account_id_handle_unique";
--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_account_id_accounts_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "documents_account_id_idx";
--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "account_id";
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_memex_id_handle_unique"
  UNIQUE ("memex_id", "handle");
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_memex_id_memexes_id_fk"
  FOREIGN KEY ("memex_id") REFERENCES "memexes"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX "documents_memex_id_idx" ON "documents" ("memex_id");
--> statement-breakpoint

-- doc_comments ───────────────────────────────────────────────────────
ALTER TABLE "doc_comments" ADD COLUMN "memex_id" uuid;
--> statement-breakpoint
UPDATE "doc_comments" c SET "memex_id" = m.memex_id
  FROM "_migration_account_to_memex" m WHERE m.account_id = c.account_id;
--> statement-breakpoint
ALTER TABLE "doc_comments" ALTER COLUMN "memex_id" SET NOT NULL;
--> statement-breakpoint
-- Drop old FK + indexes (the multicolumn drift-inbox index also keys on account_id).
ALTER TABLE "doc_comments" DROP CONSTRAINT IF EXISTS "doc_comments_account_id_accounts_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "doc_comments_account_id_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "doc_comments_drift_inbox_idx";
--> statement-breakpoint
-- author_account_id is the attribution pointer used to render "external"
-- comments at view time (`author_account_id != account_id`). In the new
-- model, "external" becomes "author's namespace differs from the doc's
-- memex's namespace" — so this column renames to author_namespace_id and
-- repoints to the user's namespace via the just-populated users.namespace_id.
ALTER TABLE "doc_comments" ADD COLUMN "author_namespace_id" uuid;
--> statement-breakpoint
UPDATE "doc_comments" c SET "author_namespace_id" = u.namespace_id
  FROM "users" u WHERE c.author_user_id = u.id;
--> statement-breakpoint
ALTER TABLE "doc_comments" DROP COLUMN IF EXISTS "author_account_id";
--> statement-breakpoint
ALTER TABLE "doc_comments" DROP COLUMN "account_id";
--> statement-breakpoint
ALTER TABLE "doc_comments" ADD CONSTRAINT "doc_comments_memex_id_memexes_id_fk"
  FOREIGN KEY ("memex_id") REFERENCES "memexes"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "doc_comments" ADD CONSTRAINT "doc_comments_author_namespace_id_namespaces_id_fk"
  FOREIGN KEY ("author_namespace_id") REFERENCES "namespaces"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX "doc_comments_memex_id_idx" ON "doc_comments" ("memex_id");
--> statement-breakpoint
-- Drift-inbox query path (services/drift-inbox.ts) per-memex stream.
CREATE INDEX "doc_comments_drift_inbox_idx" ON "doc_comments"
  ("memex_id", "comment_type", "created_at", "id");
--> statement-breakpoint

-- decisions ──────────────────────────────────────────────────────────
ALTER TABLE "decisions" ADD COLUMN "memex_id" uuid;
--> statement-breakpoint
UPDATE "decisions" SET "memex_id" = m.memex_id
  FROM "_migration_account_to_memex" m WHERE m.account_id = decisions.account_id;
--> statement-breakpoint
ALTER TABLE "decisions" ALTER COLUMN "memex_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "decisions" DROP CONSTRAINT IF EXISTS "decisions_account_id_accounts_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "decisions_account_id_idx";
--> statement-breakpoint
ALTER TABLE "decisions" DROP COLUMN "account_id";
--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_memex_id_memexes_id_fk"
  FOREIGN KEY ("memex_id") REFERENCES "memexes"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX "decisions_memex_id_idx" ON "decisions" ("memex_id");
--> statement-breakpoint

-- tasks ──────────────────────────────────────────────────────────────
ALTER TABLE "tasks" ADD COLUMN "memex_id" uuid;
--> statement-breakpoint
UPDATE "tasks" SET "memex_id" = m.memex_id
  FROM "_migration_account_to_memex" m WHERE m.account_id = tasks.account_id;
--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "memex_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "tasks_account_id_accounts_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "tasks_account_id_idx";
--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "account_id";
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_memex_id_memexes_id_fk"
  FOREIGN KEY ("memex_id") REFERENCES "memexes"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX "tasks_memex_id_idx" ON "tasks" ("memex_id");
--> statement-breakpoint

-- repos ──────────────────────────────────────────────────────────────
-- Codebase-intelligence repos are workspace-scoped (per the t-9 denorm note
-- in schema.ts), so they migrate to memex_id like other tenancy tables.
-- The two unique constraints on (accountId, url) and (accountId, name) move
-- with the column.
ALTER TABLE "repos" ADD COLUMN "memex_id" uuid;
--> statement-breakpoint
UPDATE "repos" SET "memex_id" = m.memex_id
  FROM "_migration_account_to_memex" m WHERE m.account_id = repos.account_id;
--> statement-breakpoint
ALTER TABLE "repos" ALTER COLUMN "memex_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "repos" DROP CONSTRAINT IF EXISTS "repos_account_id_url_unique";
--> statement-breakpoint
ALTER TABLE "repos" DROP CONSTRAINT IF EXISTS "repos_account_id_name_unique";
--> statement-breakpoint
ALTER TABLE "repos" DROP CONSTRAINT IF EXISTS "repos_account_id_accounts_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "repos_account_id_idx";
--> statement-breakpoint
ALTER TABLE "repos" DROP COLUMN "account_id";
--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_memex_id_url_unique" UNIQUE ("memex_id", "url");
--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_memex_id_name_unique" UNIQUE ("memex_id", "name");
--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_memex_id_memexes_id_fk"
  FOREIGN KEY ("memex_id") REFERENCES "memexes"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX "repos_memex_id_idx" ON "repos" ("memex_id");
--> statement-breakpoint

-- ─── Phase 6: Org-scoped tables — account_id → org_id ────────────────
-- Domains and invites attach to orgs only — user namespaces don't claim
-- domains or issue invites in v1.

-- invite_tokens ──────────────────────────────────────────────────────
ALTER TABLE "invite_tokens" ADD COLUMN "org_id" uuid;
--> statement-breakpoint
UPDATE "invite_tokens" SET "org_id" = m.org_id
  FROM "_migration_account_to_memex" m WHERE m.account_id = invite_tokens.account_id;
--> statement-breakpoint
-- Personal accounts can't issue invites; if any orphan rows exist (legacy
-- bug), they're discarded here rather than carried as NULL org_id.
DELETE FROM "invite_tokens" WHERE "org_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "invite_tokens" ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "invite_tokens" DROP CONSTRAINT IF EXISTS "invite_tokens_account_id_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "invite_tokens" DROP COLUMN "account_id";
--> statement-breakpoint
ALTER TABLE "invite_tokens" ADD CONSTRAINT "invite_tokens_org_id_orgs_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX "invite_tokens_org_id_idx" ON "invite_tokens" ("org_id");
--> statement-breakpoint

-- verified_domains ───────────────────────────────────────────────────
ALTER TABLE "verified_domains" ADD COLUMN "org_id" uuid;
--> statement-breakpoint
UPDATE "verified_domains" SET "org_id" = m.org_id
  FROM "_migration_account_to_memex" m WHERE m.account_id = verified_domains.account_id;
--> statement-breakpoint
DELETE FROM "verified_domains" WHERE "org_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "verified_domains" ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "verified_domains" DROP CONSTRAINT IF EXISTS "verified_domains_account_id_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "verified_domains" DROP COLUMN "account_id";
--> statement-breakpoint
ALTER TABLE "verified_domains" ADD CONSTRAINT "verified_domains_org_id_orgs_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX "verified_domains_org_id_idx" ON "verified_domains" ("org_id");
--> statement-breakpoint

-- domain_verification_tokens ─────────────────────────────────────────
ALTER TABLE "domain_verification_tokens" ADD COLUMN "org_id" uuid;
--> statement-breakpoint
UPDATE "domain_verification_tokens" SET "org_id" = m.org_id
  FROM "_migration_account_to_memex" m WHERE m.account_id = domain_verification_tokens.account_id;
--> statement-breakpoint
DELETE FROM "domain_verification_tokens" WHERE "org_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "domain_verification_tokens" ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "domain_verification_tokens" DROP CONSTRAINT IF EXISTS "domain_verification_tokens_account_id_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "domain_verification_tokens" DROP COLUMN "account_id";
--> statement-breakpoint
ALTER TABLE "domain_verification_tokens" ADD CONSTRAINT "domain_verification_tokens_org_id_orgs_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX "domain_verification_tokens_org_id_idx" ON "domain_verification_tokens" ("org_id");
--> statement-breakpoint

-- ─── Phase 7: Drop legacy ────────────────────────────────────────────

ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_personal_account_id_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_personal_account_id_unique";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "personal_account_id";
--> statement-breakpoint

DROP TABLE "account_memberships";
--> statement-breakpoint
-- referralShareTokenId column dies with the table (dec-10).
DROP TABLE "accounts";
--> statement-breakpoint

-- ─── Phase 8: Lock down namespace owner XOR + drop migration scratch ─

ALTER TABLE "namespaces" ADD CONSTRAINT "namespaces_owner_xor" CHECK (
  ("kind" = 'user' AND "owner_user_id" IS NOT NULL AND "owner_org_id" IS NULL) OR
  ("kind" = 'org'  AND "owner_org_id"  IS NOT NULL AND "owner_user_id" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "namespace_id" SET NOT NULL;
--> statement-breakpoint

DROP TABLE "_migration_account_to_memex";
