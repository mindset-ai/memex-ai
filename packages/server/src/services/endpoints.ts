import { and, eq, ilike } from "drizzle-orm";
import { db, type Db } from "../db/connection.js";
import { files, repoEndpoints, symbols } from "../db/schema.js";
import type { RepoEndpoint, RepoEndpointInsert } from "../db/schema.js";
import { bulkInsertChunks } from "./shared/bulk.js";

export async function createEndpoints(
  rows: RepoEndpointInsert[],
  client: Db = db,
): Promise<RepoEndpoint[]> {
  return bulkInsertChunks(rows, (chunk) =>
    client.insert(repoEndpoints).values(chunk).returning(),
  );
}

export interface ListEndpointsOpts {
  pathLike?: string;
  framework?: string;
}

export interface EndpointWithFile extends RepoEndpoint {
  filePath: string;
  handlerSignature: string | null;
}

export async function listEndpoints(
  repoId: string,
  opts: ListEndpointsOpts = {},
  client: Db = db,
): Promise<EndpointWithFile[]> {
  const where = [eq(repoEndpoints.repoId, repoId)];
  if (opts.framework) where.push(eq(repoEndpoints.framework, opts.framework));
  if (opts.pathLike) where.push(ilike(files.path, opts.pathLike));

  const rows = await client
    .select({
      id: repoEndpoints.id,
      repoId: repoEndpoints.repoId,
      fileId: repoEndpoints.fileId,
      handlerSymbolId: repoEndpoints.handlerSymbolId,
      method: repoEndpoints.method,
      path: repoEndpoints.path,
      handlerName: repoEndpoints.handlerName,
      lineNumber: repoEndpoints.lineNumber,
      framework: repoEndpoints.framework,
      filePath: files.path,
      handlerSignature: symbols.signature,
    })
    .from(repoEndpoints)
    .innerJoin(files, eq(files.id, repoEndpoints.fileId))
    .leftJoin(symbols, eq(symbols.id, repoEndpoints.handlerSymbolId))
    .where(and(...where))
    .orderBy(files.path, repoEndpoints.lineNumber);
  return rows;
}
