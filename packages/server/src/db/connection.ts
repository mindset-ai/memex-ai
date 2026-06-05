import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "./schema.js";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL environment variable is required");
}

// Cloud SQL socket path (e.g. /cloudsql/project:region:instance)
const socketPath = process.env.CLOUD_SQL_SOCKET;

// Connection budget (2026-06-04 prod incident): prod Cloud SQL is db-f1-micro
// with max_connections=25 (~22 usable after superuser-reserved slots). The
// postgres-js DEFAULTS are max:10 per pool and idle_timeout:0 (idle
// connections are NEVER closed), so three Cloud Run instances at full pool +
// one relay LISTEN each (spec-156) is 33 — over budget before deploy overlap
// even starts, and revision churn (old instances pinned by long-lived SSE
// streams) made it worse. Cap the pool and reap idles so the steady-state
// budget is 3 × (5 + 1 LISTEN) = 18, and deploy-overlap pressure self-heals
// as idle connections close. Overridable per-env via DB_POOL_MAX (e.g. local
// dev and tests, where a single process wants more parallelism).
const poolMax = Number(process.env.DB_POOL_MAX ?? 5);
const poolOptions = {
  max: poolMax,
  // Seconds an idle connection lingers before being closed. Keeps drained
  // revisions from squatting on slots they'll never use again.
  idle_timeout: 60,
  // Proactively recycle long-lived connections (seconds) so slot usage stays
  // observable and Cloud SQL maintenance reconnects are exercised regularly.
  max_lifetime: 60 * 30,
} as const;

const client = socketPath
  ? postgres(connectionString, { host: socketPath, ...poolOptions })
  : postgres(connectionString, poolOptions);

export const db = drizzle(client, { schema });

// The raw postgres-js pooled client. Exposed so the cross-instance bus relay
// (services/bus-relay.ts, spec-156) can issue fire-and-forget NOTIFY statements
// on the existing pool — a NOTIFY needs no dedicated socket. The relay's LISTEN
// side, by contrast, opens its OWN single connection and never touches this.
export const sqlClient = client;

// Shared connection-or-transaction type. Every service function takes this
// as an optional parameter so the same code runs standalone (using the db
// singleton) or inside `db.transaction(async (tx) => { ... })`, without
// any API divergence. Drizzle 0.39's tx callback parameter is a
// `PgTransaction`, not a `PostgresJsDatabase` (the db singleton adds a
// `$client` intersection that tx lacks), so the usable shape for service
// code is the union of both.
export type Db =
  | typeof db
  | PgTransaction<
      PostgresJsQueryResultHKT,
      typeof schema,
      ExtractTablesWithRelations<typeof schema>
    >;

// DI accessor (Batch 6 groundwork). New code should call `getDb()` rather
// than importing `db` directly so tests can swap the implementation via
// `setDb()`. Existing call sites keep using the raw `db` export —
// migration is opportunistic, not required.
let active: Db = db;
export function getDb(): Db {
  return active;
}
export function setDb(next: Db | null): void {
  active = next ?? db;
}

// Exposed so short-lived CLI tools (extractor, seed scripts) can shut down
// cleanly. Server process leaves this open for the lifetime of the server.
export async function closeDb(): Promise<void> {
  await client.end();
}
