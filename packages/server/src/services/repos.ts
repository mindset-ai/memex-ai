import { and, eq, sql } from "drizzle-orm";
import { db, type Db } from "../db/connection.js";
import {
  repos,
  repoScope,
  files,
  symbols,
  dependencies,
  calls,
  embeddings,
  repoEndpoints,
  repoStructure,
  repoPatterns,
  repoDomains,
  repoTechStack,
  testCoverage,
} from "../db/schema.js";
import type { Repo, RepoScope } from "../db/schema.js";
import { NotFoundError } from "../types/errors.js";

export interface CreateRepoInput {
  memexId: string;
  name: string;
  url: string;
  defaultBranch?: string;
}

export async function createRepo(input: CreateRepoInput, client: Db = db): Promise<Repo> {
  const [row] = await client
    .insert(repos)
    .values({
      memexId: input.memexId,
      name: input.name,
      url: input.url,
      defaultBranch: input.defaultBranch ?? "main",
      lastSyncedAt: new Date(),
    })
    .returning();
  return row!;
}

export async function getRepoById(id: string, memexId: string, client: Db = db): Promise<Repo | null> {
  // Scoped to account. Returns null rather than leaking cross-tenant rows.
  const [row] = await client
    .select()
    .from(repos)
    .where(and(eq(repos.id, id), eq(repos.memexId, memexId)));
  return row ?? null;
}

export async function getRepoByUrl(memexId: string, url: string, client: Db = db): Promise<Repo | null> {
  const [row] = await client
    .select()
    .from(repos)
    .where(and(eq(repos.memexId, memexId), eq(repos.url, url)));
  return row ?? null;
}

// Match by name within an account. Safe because of UNIQUE(account_id, name) on repos.
export async function getRepoByName(memexId: string, name: string, client: Db = db): Promise<Repo | null> {
  const [row] = await client
    .select()
    .from(repos)
    .where(and(eq(repos.memexId, memexId), eq(repos.name, name)));
  return row ?? null;
}

// Resolve a repoRef (UUID | URL | name) within an account, or throw.
// Lives in the service layer so every consumer (MCP tool, chat agent tool,
// future REST route, Slack integration) uses the same lookup. UNIQUE(account_id, name)
// makes the name-lookup unambiguous per workspace.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function resolveRepoRef(
  memexId: string,
  repoRef: string,
  client: Db = db,
): Promise<Repo> {
  if (UUID_RE.test(repoRef)) {
    const byId = await getRepoById(repoRef, memexId, client);
    if (byId) return byId;
  }
  const byName = await getRepoByName(memexId, repoRef, client);
  if (byName) return byName;
  const byUrl = await getRepoByUrl(memexId, repoRef, client);
  if (byUrl) return byUrl;
  // Use the platform-level NotFoundError so the MCP/REST error handlers
  // already map it to a 404 / "Not found" response unchanged.
  throw new NotFoundError(
    `No repo matching '${repoRef}' for this workspace. Use list_repos to see available repos.`,
  );
}

export async function listRepos(memexId: string, client: Db = db): Promise<Repo[]> {
  return await client.select().from(repos).where(eq(repos.memexId, memexId));
}

// Idempotent: (account_id, url) is unique, so re-running the extractor reuses
// the repo row rather than erroring. Returns created=true only on first write.
export async function getOrCreateRepo(
  input: CreateRepoInput,
  client: Db = db,
): Promise<{ repo: Repo; created: boolean }> {
  const existing = await getRepoByUrl(input.memexId, input.url, client);
  if (existing) return { repo: existing, created: false };
  const repo = await createRepo(input, client);
  return { repo, created: true };
}

export async function touchLastSynced(repoId: string, client: Db = db): Promise<void> {
  await client.update(repos).set({ lastSyncedAt: new Date() }).where(eq(repos.id, repoId));
}

// Hard delete of a repo row. FK cascades remove every child table.
// Caller must have already authorised the delete by checking memexId.
export async function deleteRepo(repoId: string, memexId: string, client: Db = db): Promise<void> {
  await client.delete(repos).where(and(eq(repos.id, repoId), eq(repos.memexId, memexId)));
}

// Wipes every distillation row for a repo without deleting the repo itself.
// Used by the extractor on re-ingest: same repo, fresh data. MUST be called
// inside a transaction that also does the re-insert — otherwise a crash leaves
// partial state.
export async function clearRepoData(repoId: string, client: Db = db): Promise<void> {
  await client.delete(embeddings).where(eq(embeddings.repoId, repoId));
  await client.delete(calls).where(eq(calls.repoId, repoId));
  await client.delete(dependencies).where(eq(dependencies.repoId, repoId));
  await client.delete(testCoverage).where(eq(testCoverage.repoId, repoId));
  await client.delete(repoEndpoints).where(eq(repoEndpoints.repoId, repoId));
  await client.delete(symbols).where(eq(symbols.repoId, repoId));
  await client.delete(files).where(eq(files.repoId, repoId));
  await client.delete(repoStructure).where(eq(repoStructure.repoId, repoId));
  await client.delete(repoPatterns).where(eq(repoPatterns.repoId, repoId));
  await client.delete(repoDomains).where(eq(repoDomains.repoId, repoId));
  await client.delete(repoTechStack).where(eq(repoTechStack.repoId, repoId));
  await client.delete(repoScope).where(eq(repoScope.repoId, repoId));
}

export async function setRepoScope(repoId: string, includePaths: string[], client: Db = db): Promise<void> {
  await client.delete(repoScope).where(eq(repoScope.repoId, repoId));
  if (includePaths.length === 0) return;
  await client.insert(repoScope).values(includePaths.map((includePath) => ({ repoId, includePath })));
}

export async function listRepoScope(repoId: string, client: Db = db): Promise<RepoScope[]> {
  return await client.select().from(repoScope).where(eq(repoScope.repoId, repoId));
}

export interface RepoOverviewCounts {
  files: number;
  symbols: number;
  dependencies: number;
  calls: number;
  endpoints: number;
  domains: number;
}

export async function getRepoOverviewCounts(repoId: string, client: Db = db): Promise<RepoOverviewCounts> {
  const [row] = await client
    .select({
      files: sql<number>`(select count(*)::int from ${files} where ${files.repoId} = ${repoId})`,
      symbols: sql<number>`(select count(*)::int from ${symbols} where ${symbols.repoId} = ${repoId})`,
      dependencies: sql<number>`(select count(*)::int from ${dependencies} where ${dependencies.repoId} = ${repoId})`,
      calls: sql<number>`(select count(*)::int from ${calls} where ${calls.repoId} = ${repoId})`,
      endpoints: sql<number>`(select count(*)::int from ${repoEndpoints} where ${repoEndpoints.repoId} = ${repoId})`,
      domains: sql<number>`(select count(*)::int from ${repoDomains} where ${repoDomains.repoId} = ${repoId})`,
    })
    .from(sql`(select 1) as _`);
  return row!;
}
