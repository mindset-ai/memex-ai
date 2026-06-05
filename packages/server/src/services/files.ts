import { and, eq, sql } from "drizzle-orm";
import { db, type Db } from "../db/connection.js";
import { files } from "../db/schema.js";
import type { File, FileInsert } from "../db/schema.js";
import { bulkInsertChunks } from "./shared/bulk.js";

export async function createFiles(rows: FileInsert[], client: Db = db): Promise<File[]> {
  return bulkInsertChunks(rows, (chunk) => client.insert(files).values(chunk).returning());
}

// Repo-scoped lookup. Returns null if the file doesn't belong to the repo —
// prevents cross-tenant file access when a stolen fileId is passed in.
export async function getFileById(repoId: string, id: string, client: Db = db): Promise<File | null> {
  const [row] = await client
    .select()
    .from(files)
    .where(and(eq(files.id, id), eq(files.repoId, repoId)));
  return row ?? null;
}

export async function getFileByPath(repoId: string, path: string, client: Db = db): Promise<File | null> {
  const [row] = await client
    .select()
    .from(files)
    .where(and(eq(files.repoId, repoId), eq(files.path, path)));
  return row ?? null;
}

export interface ListFilesOpts {
  language?: string;
  isTest?: boolean;
  limit?: number;
}

export async function listFiles(
  repoId: string,
  opts: ListFilesOpts = {},
  client: Db = db,
): Promise<File[]> {
  const where = [eq(files.repoId, repoId)];
  if (opts.language !== undefined) where.push(eq(files.language, opts.language));
  if (opts.isTest !== undefined) where.push(eq(files.isTest, opts.isTest));
  const query = client
    .select()
    .from(files)
    .where(and(...where));
  if (opts.limit !== undefined) return await query.limit(opts.limit);
  return await query;
}

export async function searchFileContent(
  repoId: string,
  query: string,
  limit = 10,
  client: Db = db,
): Promise<Array<File & { rank: number }>> {
  // Compute plainto_tsquery once in a CTE, reuse three times (match,
  // rank, order). Saves planner work and forces a single tokenisation
  // even under planner changes.
  const rows = await client.execute(sql`
    WITH q AS (SELECT plainto_tsquery('english', ${query}) AS tsq)
    SELECT
      f.id, f.repo_id AS "repoId", f.path, f.language, f.content,
      f.content_tsv AS "contentTsv", f.size_bytes AS "sizeBytes",
      f.git_hash AS "gitHash", f.is_test AS "isTest",
      f.last_updated_at AS "lastUpdatedAt",
      ts_rank_cd(f.content_tsv, q.tsq) AS rank
    FROM ${files} f, q
    WHERE f.repo_id = ${repoId}
      AND f.content_tsv @@ q.tsq
    ORDER BY rank DESC
    LIMIT ${limit}
  `);
  return rows as unknown as Array<File & { rank: number }>;
}
