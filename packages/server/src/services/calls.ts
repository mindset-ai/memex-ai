import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, type Db } from "../db/connection.js";
import { calls, files, symbols } from "../db/schema.js";
import type { Call, CallInsert } from "../db/schema.js";
import { bulkInsertChunks } from "./shared/bulk.js";

export async function createCalls(rows: CallInsert[], client: Db = db): Promise<Call[]> {
  return bulkInsertChunks(rows, (chunk) => client.insert(calls).values(chunk).returning());
}

// Language-scoped noise marking. Each language has its own notion of noise
// (Python's `range`, TS's `forEach`, etc.). A union would cross-contaminate:
// a Python file with a user-defined `Set` function would get marked noise
// because `Set` is in the TS list. Callers invoke this once per language;
// a join through files.language filters to that language only, so language
// X's noise list cannot touch language Y's calls.
export async function markNoiseCalls(
  repoId: string,
  language: string,
  noiseNames: string[],
  client: Db = db,
): Promise<number> {
  if (noiseNames.length === 0) return 0;
  const matching = client
    .select({ id: calls.id })
    .from(calls)
    .innerJoin(symbols, eq(symbols.id, calls.fromSymbolId))
    .innerJoin(files, eq(files.id, symbols.fileId))
    .where(
      and(
        eq(calls.repoId, repoId),
        isNull(calls.toSymbolId),
        // Don't override calls already labelled (e.g. 'external'). External
        // is more informative than generic noise.
        isNull(calls.resolutionKind),
        inArray(calls.toName, noiseNames),
        eq(files.language, language),
      ),
    );
  const result = await client
    .update(calls)
    .set({ isNoise: true })
    .where(inArray(calls.id, matching));
  return result.count ?? 0;
}

// Labels every resolved call as 'local' (caller + callee in same file) or
// 'cross_module'. Language-agnostic. Single-pass JOIN: one seq-scan on
// the relevant calls, two index lookups per row on symbols. Replaces an
// earlier correlated-subquery version that ran a subquery per row.
export async function labelCallResolutionKinds(repoId: string, client: Db = db): Promise<void> {
  await client.execute(sql`
    UPDATE ${calls} c SET resolution_kind =
      CASE WHEN sf.file_id = tf.file_id THEN 'local' ELSE 'cross_module' END
    FROM ${symbols} sf, ${symbols} tf
    WHERE c.repo_id = ${repoId}
      AND c.to_symbol_id IS NOT NULL
      AND c.resolution_kind IS NULL
      AND sf.id = c.from_symbol_id
      AND tf.id = c.to_symbol_id
  `);
}

// Language-scoped inheritance resolution. Walks class inheritance chains
// using the language's signature format (provided by parseParentClass).
// Only classes and methods from files of that language enter the lookup —
// so a Python class `Foo` and a TS class `Foo` cannot collide in the map.
export async function resolveInheritanceCalls(
  repoId: string,
  language: string,
  parseParentClass: (signature: string) => string | null,
  client: Db = db,
): Promise<number> {
  type ClassInfo = { id: string; signature: string; fileId: string; parentName: string | null };

  const classRows = await client
    .select({
      id: symbols.id,
      name: symbols.name,
      signature: symbols.signature,
      fileId: symbols.fileId,
    })
    .from(symbols)
    .innerJoin(files, eq(files.id, symbols.fileId))
    .where(
      and(eq(symbols.repoId, repoId), eq(symbols.kind, "class"), eq(files.language, language)),
    );

  const classes = new Map<string, ClassInfo>();
  for (const row of classRows) {
    classes.set(row.name, {
      id: row.id,
      signature: row.signature ?? "",
      fileId: row.fileId,
      parentName: parseParentClass(row.signature ?? ""),
    });
  }

  const methodRows = await client
    .select({ id: symbols.id, name: symbols.name, parentName: symbols.parentName })
    .from(symbols)
    .innerJoin(files, eq(files.id, symbols.fileId))
    .where(
      and(
        eq(symbols.repoId, repoId),
        eq(symbols.kind, "method"),
        sql`${symbols.parentName} IS NOT NULL`,
        eq(files.language, language),
      ),
    );

  const methodLookup = new Map<string, string>();
  for (const row of methodRows) {
    if (row.parentName) methodLookup.set(`${row.parentName}::${row.name}`, row.id);
  }

  const unresolvedRows = await client
    .select({ id: calls.id, toName: calls.toName, parentName: symbols.parentName })
    .from(calls)
    .innerJoin(symbols, eq(symbols.id, calls.fromSymbolId))
    .innerJoin(files, eq(files.id, symbols.fileId))
    .where(
      and(
        eq(calls.repoId, repoId),
        isNull(calls.toSymbolId),
        eq(calls.isNoise, false),
        eq(symbols.kind, "method"),
        sql`${symbols.parentName} IS NOT NULL`,
        eq(files.language, language),
      ),
    );

  let resolvedCount = 0;
  const updates: Array<{ id: string; toSymbolId: string }> = [];
  for (const row of unresolvedRows) {
    let currentClass: string | null = row.parentName ?? null;
    const visited = new Set<string>();
    let resolvedId: string | null = null;

    while (currentClass && !visited.has(currentClass)) {
      visited.add(currentClass);
      const key = `${currentClass}::${row.toName}`;
      const found = methodLookup.get(key);
      if (found) {
        resolvedId = found;
        break;
      }
      const info = classes.get(currentClass);
      if (info && info.parentName) currentClass = info.parentName;
      else break;
    }

    if (resolvedId) updates.push({ id: row.id, toSymbolId: resolvedId });
  }

  // Batch the UPDATEs: one per resolved row would be N round trips.
  // Group by target symbol id to reduce to ~unique-target round trips.
  const byTarget = new Map<string, string[]>();
  for (const u of updates) {
    const arr = byTarget.get(u.toSymbolId) ?? [];
    arr.push(u.id);
    byTarget.set(u.toSymbolId, arr);
  }
  for (const [toSymbolId, callIds] of byTarget) {
    await client
      .update(calls)
      .set({ toSymbolId, resolutionKind: "inheritance" })
      .where(inArray(calls.id, callIds));
    resolvedCount += callIds.length;
  }

  return resolvedCount;
}

export interface CallGraphRow {
  id: string;
  toName: string;
  lineNumber: number | null;
  resolutionKind: string | null;
  isNoise: boolean;
  fromSymbolName: string;
  fromPath: string;
  toSymbolName: string | null;
  toPath: string | null;
}

// Repo-scoped call-graph queries. Every subselect is constrained by
// repoId so a symbolId from another repo can't leak name/path through
// the toSymbolName / toPath columns even if somehow the caller smuggles
// an unrelated id. Encoding the invariant in the SQL shape means we
// don't rely on an ingestion-only contract to hold forever.
export async function getCallersOf(
  repoId: string,
  symbolId: string,
  opts: { includeNoise?: boolean; limit?: number } = {},
  client: Db = db,
): Promise<CallGraphRow[]> {
  const fromSymbols = symbols;
  const rows = await client
    .select({
      id: calls.id,
      toName: calls.toName,
      lineNumber: calls.lineNumber,
      resolutionKind: calls.resolutionKind,
      isNoise: calls.isNoise,
      fromSymbolName: fromSymbols.name,
      fromPath: files.path,
      toSymbolName: sql<
        string | null
      >`(select name from ${symbols} where id = ${calls.toSymbolId} and repo_id = ${repoId})`,
      toPath: sql<
        string | null
      >`(select ${files.path} from ${files} inner join ${symbols} on ${symbols.fileId} = ${files.id} where ${symbols.id} = ${calls.toSymbolId} and ${symbols.repoId} = ${repoId})`,
    })
    .from(calls)
    .innerJoin(fromSymbols, eq(fromSymbols.id, calls.fromSymbolId))
    .innerJoin(files, eq(files.id, fromSymbols.fileId))
    .where(
      and(
        eq(calls.repoId, repoId),
        eq(calls.toSymbolId, symbolId),
        opts.includeNoise ? sql`TRUE` : eq(calls.isNoise, false),
      ),
    )
    .limit(opts.limit ?? 50);
  return rows;
}

export async function getCalleesOf(
  repoId: string,
  symbolId: string,
  opts: { includeNoise?: boolean; limit?: number } = {},
  client: Db = db,
): Promise<CallGraphRow[]> {
  const fromSymbols = symbols;
  const rows = await client
    .select({
      id: calls.id,
      toName: calls.toName,
      lineNumber: calls.lineNumber,
      resolutionKind: calls.resolutionKind,
      isNoise: calls.isNoise,
      fromSymbolName: fromSymbols.name,
      fromPath: files.path,
      toSymbolName: sql<
        string | null
      >`(select name from ${symbols} where id = ${calls.toSymbolId} and repo_id = ${repoId})`,
      toPath: sql<
        string | null
      >`(select ${files.path} from ${files} inner join ${symbols} on ${symbols.fileId} = ${files.id} where ${symbols.id} = ${calls.toSymbolId} and ${symbols.repoId} = ${repoId})`,
    })
    .from(calls)
    .innerJoin(fromSymbols, eq(fromSymbols.id, calls.fromSymbolId))
    .innerJoin(files, eq(files.id, fromSymbols.fileId))
    .where(
      and(
        eq(calls.repoId, repoId),
        eq(calls.fromSymbolId, symbolId),
        opts.includeNoise ? sql`TRUE` : eq(calls.isNoise, false),
      ),
    )
    .limit(opts.limit ?? 50);
  return rows;
}
