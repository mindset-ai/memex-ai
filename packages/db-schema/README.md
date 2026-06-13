# @mindset-ai/db-schema

The Memex production database schema, as a **standalone, typed Drizzle package** —
the single cross-repo artifact the **Backstage** operator control plane (spec-280)
consumes. It is built from the one source of truth, `packages/server/src/db/schema.ts`,
and published to **private GitHub Packages** (spec-279).

It is **not** on public npm and **not** `@memex/*` (that scope is unavailable, spec-89).
Building or running the open-source `memex-ai` repo never requires installing it —
this package is outbound-only, consumed solely by in-org repos.

## Install (from an in-org repo, e.g. Backstage)

`@mindset-ai/db-schema` lives on GitHub Packages. Point the `@mindset-ai` scope at
that registry and authenticate with a `GITHUB_TOKEN` (the built-in Actions token in
CI, or a `read:packages` PAT locally). Add to the consumer repo's `.npmrc`:

```ini
@mindset-ai:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Then:

```bash
npm install @mindset-ai/db-schema drizzle-orm postgres
```

Pin an exact version — the publish workflow bumps the version only when the schema
actually changes (a content-hash guard), and the [drift gate](#drift-gate) guarantees
a pinned version still matches the real database.

## Use

```ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { documents, type Doc } from "@mindset-ai/db-schema";

const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
const db = drizzle(sql);

const rows: Doc[] = await db.select().from(documents).limit(10);
```

The package exports the Drizzle table objects **and** their inferred row/insert
types (`Doc`, `NewDoc`, …), with zero workspace dependencies — `drizzle-orm` is the
only runtime dependency.

## Cross-tenant role posture (read before you connect)

Tenant isolation is enforced in Postgres via **RLS** (row-level security). The app
connects with a tenant-scoped role that RLS confines to one tenant. Backstage is an
operator console that must read **across** tenants, so it connects as a dedicated
**`BYPASSRLS` role (`memex_admin`)** — distinct from the app's role. Treat that
credential as privileged and audited.

Backstage **owns its own control-plane tables** in a separate **`admin` Postgres
schema** with its own migration history, and **never writes `public.*` directly** —
tenant mutations go through the core API / `mutate()` bus (std-8). This package gives
Backstage typed **read** access to `public.*`; it does not grant or imply write access.

## Typed subset

The package is an intentional **typed subset** of the database. The real DB carries a
few columns the schema deliberately does not model — pgvector `embedding*`, tsvector
`content_tsv`, and bookkeeping tables (`manual_migrations`) — because Drizzle doesn't
first-class those Postgres types. The drift gate accounts for this (see below).

## Drift gate

CI migrates a cold database and runs `scripts/drift-gate.mjs`, which diffs every
table/column the package **declares** against the live DB. It fails the build when the
DB is **missing** anything the package declares (the stale-package danger), so a pinned
consumer can never silently run against a schema that has moved on. DB objects the
package doesn't model are reported as info, never failures.

## Build

```bash
pnpm --filter @mindset-ai/db-schema build   # tsup → dist/index.js (ESM) + dist/index.d.ts
```
