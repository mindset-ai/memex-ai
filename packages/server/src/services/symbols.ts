import { and, eq, ilike, sql } from "drizzle-orm";
import { db, type Db } from "../db/connection.js";
import { files, symbols } from "../db/schema.js";
import type { Symbol, SymbolInsert } from "../db/schema.js";
import { bulkInsertChunks } from "./shared/bulk.js";

export async function createSymbols(rows: SymbolInsert[], client: Db = db): Promise<Symbol[]> {
  return bulkInsertChunks(rows, (chunk) => client.insert(symbols).values(chunk).returning());
}

export async function getSymbolById(
  repoId: string,
  id: string,
  client: Db = db,
): Promise<Symbol | null> {
  // Scoped to repo — prevents cross-tenant symbol id lookup.
  const [row] = await client
    .select()
    .from(symbols)
    .where(and(eq(symbols.id, id), eq(symbols.repoId, repoId)));
  return row ?? null;
}

export interface FindSymbolOpts {
  kind?: string;
  exportedOnly?: boolean;
  pathLike?: string;
  limit?: number;
}

export async function findSymbols(
  repoId: string,
  nameQuery: string,
  opts: FindSymbolOpts = {},
  client: Db = db,
): Promise<Array<Symbol & { filePath: string }>> {
  const where = [eq(symbols.repoId, repoId), ilike(symbols.name, `%${nameQuery}%`)];
  if (opts.kind) where.push(eq(symbols.kind, opts.kind));
  if (opts.exportedOnly) where.push(eq(symbols.isExported, true));
  if (opts.pathLike) where.push(ilike(files.path, opts.pathLike));
  const rows = await client
    .select({
      id: symbols.id,
      repoId: symbols.repoId,
      fileId: symbols.fileId,
      name: symbols.name,
      kind: symbols.kind,
      parentName: symbols.parentName,
      signature: symbols.signature,
      lineStart: symbols.lineStart,
      lineEnd: symbols.lineEnd,
      isExported: symbols.isExported,
      isAsync: symbols.isAsync,
      language: symbols.language,
      docComment: symbols.docComment,
      filePath: files.path,
    })
    .from(symbols)
    .innerJoin(files, eq(symbols.fileId, files.id))
    .where(and(...where))
    .limit(opts.limit ?? 25);
  return rows;
}

// Repo-scoped. Callers must supply the repoId they've already authorised
// (via getRepoOrThrow in the tool layer). Leaving this unscoped was a
// cross-tenant hazard even if no current caller exploited it.
export async function listSymbolsByFile(
  repoId: string,
  fileId: string,
  client: Db = db,
): Promise<Symbol[]> {
  return await client
    .select()
    .from(symbols)
    .where(and(eq(symbols.repoId, repoId), eq(symbols.fileId, fileId)))
    .orderBy(symbols.lineStart);
}

export async function getSymbolCountsByKind(
  repoId: string,
  client: Db = db,
): Promise<Record<string, number>> {
  const rows = await client
    .select({ kind: symbols.kind, count: sql<number>`count(*)::int` })
    .from(symbols)
    .where(eq(symbols.repoId, repoId))
    .groupBy(symbols.kind);
  const out: Record<string, number> = {};
  for (const row of rows) out[row.kind] = row.count;
  return out;
}
