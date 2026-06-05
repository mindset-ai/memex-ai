import { and, eq, sql } from "drizzle-orm";
import { db, type Db } from "../db/connection.js";
import {
  repoDomains,
  repoPatterns,
  repoStructure,
  repoTechStack,
} from "../db/schema.js";
import type {
  RepoDomain,
  RepoPattern,
  RepoStructure,
  RepoTechStack,
} from "../db/schema.js";
import { bulkInsertChunks } from "./shared/bulk.js";

export interface StructureInsert {
  repoId: string;
  kind: string;
  pathPattern: string;
  fileCount?: number;
  confidence?: number;
}

export async function createStructure(
  rows: StructureInsert[],
  client: Db = db,
): Promise<RepoStructure[]> {
  return bulkInsertChunks(rows, (chunk) =>
    client.insert(repoStructure).values(chunk).returning(),
  );
}

export interface PatternInsert {
  repoId: string;
  pattern: string;
  evidence?: string[];
  confidence?: number;
}

export async function createPatterns(
  rows: PatternInsert[],
  client: Db = db,
): Promise<RepoPattern[]> {
  return bulkInsertChunks(rows, (chunk) =>
    client.insert(repoPatterns).values(chunk).returning(),
  );
}

export interface DomainInsert {
  repoId: string;
  name: string;
  rootPaths?: string[];
  fileCount?: number;
  symbolCount?: number;
  keySymbols?: string[];
  aliases?: string[];
  description?: string;
}

export async function createDomains(
  rows: DomainInsert[],
  client: Db = db,
): Promise<RepoDomain[]> {
  return bulkInsertChunks(rows, (chunk) =>
    client.insert(repoDomains).values(chunk).returning(),
  );
}

export async function setDomainAliases(
  repoId: string,
  name: string,
  aliases: string[],
  description: string | null,
  client: Db = db,
): Promise<void> {
  await client
    .update(repoDomains)
    .set({ aliases, description })
    .where(and(eq(repoDomains.repoId, repoId), eq(repoDomains.name, name)));
}

export async function resolveDomainByAlias(
  repoId: string,
  alias: string,
  client: Db = db,
): Promise<RepoDomain | null> {
  const [row] = await client
    .select()
    .from(repoDomains)
    .where(and(eq(repoDomains.repoId, repoId), sql`${alias} = ANY(${repoDomains.aliases})`))
    .limit(1);
  return row ?? null;
}

export async function listDomains(repoId: string, client: Db = db): Promise<RepoDomain[]> {
  return await client
    .select()
    .from(repoDomains)
    .where(eq(repoDomains.repoId, repoId))
    .orderBy(sql`${repoDomains.fileCount} desc nulls last`);
}

export interface TechStackInsert {
  repoId: string;
  layer: string;
  name: string;
  version?: string;
  evidence?: string[];
}

export async function createTechStack(
  rows: TechStackInsert[],
  client: Db = db,
): Promise<RepoTechStack[]> {
  return bulkInsertChunks(rows, (chunk) =>
    client.insert(repoTechStack).values(chunk).returning(),
  );
}

export async function listTechStack(
  repoId: string,
  client: Db = db,
): Promise<RepoTechStack[]> {
  return await client.select().from(repoTechStack).where(eq(repoTechStack.repoId, repoId));
}

export async function listStructure(
  repoId: string,
  client: Db = db,
): Promise<RepoStructure[]> {
  return await client.select().from(repoStructure).where(eq(repoStructure.repoId, repoId));
}
