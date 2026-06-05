import { and, eq, or, sql } from "drizzle-orm";
import { db, type Db } from "../db/connection.js";
import { dependencies, files } from "../db/schema.js";
import type { Dependency, DependencyInsert } from "../db/schema.js";
import { bulkInsertChunks } from "./shared/bulk.js";

// "Imports" in Memex terminology = file-to-file (or file-to-external-package)
// module dependencies. Distinct from services/dependencies.ts which is about
// task-to-decision and task-to-task blockers.

export async function createDependencies(
  rows: DependencyInsert[],
  client: Db = db,
): Promise<Dependency[]> {
  return bulkInsertChunks(rows, (chunk) =>
    client.insert(dependencies).values(chunk).returning(),
  );
}

// repoId is required for scoping; the query also verifies the file belongs
// to the repo, blocking cross-tenant fileId probing.
export async function getImportsForFile(
  repoId: string,
  fileId: string,
  direction: "imports" | "importers" | "both" = "both",
  client: Db = db,
): Promise<Array<Dependency & { fromPath: string | null; toPath: string | null }>> {
  const rows = await client
    .select({
      id: dependencies.id,
      repoId: dependencies.repoId,
      fromFileId: dependencies.fromFileId,
      toFileId: dependencies.toFileId,
      toPackage: dependencies.toPackage,
      importedSymbols: dependencies.importedSymbols,
      kind: dependencies.kind,
      fromPath: sql<string | null>`(select ${files.path} from ${files} where ${files.id} = ${dependencies.fromFileId})`,
      toPath: sql<string | null>`(select ${files.path} from ${files} where ${files.id} = ${dependencies.toFileId})`,
    })
    .from(dependencies)
    .where(
      and(
        eq(dependencies.repoId, repoId),
        direction === "imports"
          ? eq(dependencies.fromFileId, fileId)
          : direction === "importers"
            ? eq(dependencies.toFileId, fileId)
            : or(eq(dependencies.fromFileId, fileId), eq(dependencies.toFileId, fileId)),
      ),
    );
  return rows;
}

export async function getFileImpact(
  repoId: string,
  fileId: string,
  depth = 3,
  client: Db = db,
): Promise<Array<{ fileId: string; path: string; distance: number }>> {
  const rows = await client.execute(sql`
    WITH RECURSIVE impact AS (
      SELECT ${dependencies.fromFileId} AS file_id, 1 AS distance
      FROM ${dependencies}
      WHERE ${dependencies.repoId} = ${repoId} AND ${dependencies.toFileId} = ${fileId}
      UNION
      SELECT d.from_file_id AS file_id, i.distance + 1 AS distance
      FROM ${dependencies} d
      JOIN impact i ON d.to_file_id = i.file_id
      WHERE d.repo_id = ${repoId} AND i.distance < ${depth}
    )
    SELECT DISTINCT i.file_id AS "fileId", f.path, min(i.distance) AS distance
    FROM impact i
    JOIN ${files} f ON f.id = i.file_id
    WHERE f.repo_id = ${repoId}
    GROUP BY i.file_id, f.path
    ORDER BY distance, f.path
  `);
  return rows as unknown as Array<{ fileId: string; path: string; distance: number }>;
}
