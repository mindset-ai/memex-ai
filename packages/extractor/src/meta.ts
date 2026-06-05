import { relative, dirname, basename } from "node:path";
import type { DepRecord, ExtractedImport } from "./types.ts";

export interface StructureRow {
  kind: string;
  pathPattern: string;
  fileCount: number;
  confidence: number;
}

export interface TechStackRow {
  layer: string;
  name: string;
  evidence: string[];
}

export interface DomainRow {
  name: string;
  rootPaths: string[];
  fileCount: number;
}

const KIND_KEYWORDS: Record<string, string[]> = {
  routes: ["routes", "routers", "endpoints", "api", "handlers", "views"],
  models: ["models", "entities", "schemas", "types"],
  services: ["services", "service", "usecases", "use_cases"],
  tests: ["test", "tests", "__tests__", "spec", "specs"],
  config: ["config", "configuration", "settings"],
  shared: ["shared", "common", "utils", "utilities", "helpers", "lib"],
  migrations: ["migrations", "alembic", "migrate"],
};

export function detectStructure(absFilePaths: string[], basePath: string): StructureRow[] {
  const dirCounts = new Map<string, number>();
  for (const fp of absFilePaths) {
    const rel = relative(basePath, fp);
    const parts = rel.split("/").filter((p) => p.length > 0);
    for (let i = 0; i < parts.length - 1; i++) {
      const dirPath = parts.slice(0, i + 1).join("/");
      dirCounts.set(dirPath, (dirCounts.get(dirPath) ?? 0) + 1);
    }
  }

  const rows: StructureRow[] = [];
  for (const [kind, keywords] of Object.entries(KIND_KEYWORDS)) {
    for (const [dirPath, count] of dirCounts) {
      const dirName = basename(dirPath).toLowerCase();
      if (keywords.includes(dirName)) {
        const confidence = Math.min(1.0, count / 5);
        rows.push({
          kind,
          pathPattern: dirPath,
          fileCount: count,
          confidence: Math.round(confidence * 100) / 100,
        });
        break;
      }
    }
  }
  return rows;
}

const TECH_DETECTIONS: Array<[string, string, Set<string>]> = [
  ["framework", "fastapi", new Set(["fastapi"])],
  ["framework", "flask", new Set(["flask"])],
  ["framework", "django", new Set(["django"])],
  ["database", "postgres", new Set(["psycopg2", "asyncpg", "sqlalchemy"])],
  ["database", "firestore", new Set(["google", "firebase_admin"])],
  ["database", "redis", new Set(["redis", "aioredis"])],
  ["ai", "langchain", new Set(["langchain", "langchain_core", "langchain_anthropic", "langchain_openai"])],
  ["ai", "langgraph", new Set(["langgraph"])],
  ["ai", "openai", new Set(["openai"])],
  ["ai", "anthropic", new Set(["anthropic"])],
  ["testing", "pytest", new Set(["pytest"])],
  ["testing", "unittest", new Set(["unittest"])],
  ["messaging", "pubsub", new Set(["google"])],
  ["http", "requests", new Set(["requests", "httpx"])],
  ["http", "aiohttp", new Set(["aiohttp"])],
  ["search", "zilliz", new Set(["pymilvus"])],
  ["auth", "firebase", new Set(["firebase_admin"])],
  ["gcp", "secret_manager", new Set(["google"])],
];

export function detectTechStack(allImports: ExtractedImport[]): TechStackRow[] {
  const importNames = new Set<string>();
  for (const imp of allImports) {
    importNames.add(imp.module.split(".")[0] ?? imp.module);
  }
  const out: TechStackRow[] = [];
  for (const [layer, name, triggers] of TECH_DETECTIONS) {
    const evidence: string[] = [];
    for (const t of triggers) {
      if (importNames.has(t)) evidence.push(t);
    }
    if (evidence.length > 0) {
      // Sorted for determinism. Python's set intersection happened to emit
      // alphabetical order for the inputs we tested, so this matches in
      // practice; more importantly, it never varies run-to-run.
      evidence.sort();
      out.push({ layer, name, evidence });
    }
  }
  return out;
}

export function detectDomains(
  absFilePaths: string[],
  basePath: string,
  _deps: DepRecord[],
): DomainRow[] {
  const domains = new Map<string, { paths: Set<string>; files: number }>();
  for (const fp of absFilePaths) {
    const rel = relative(basePath, fp);
    const parts = rel.split("/").filter((p) => p.length > 0);
    if (parts.length >= 2) {
      const name = parts[0]!;
      const entry = domains.get(name) ?? { paths: new Set<string>(), files: 0 };
      entry.paths.add(parts[0]!);
      entry.files += 1;
      domains.set(name, entry);
    } else {
      const entry = domains.get("root") ?? { paths: new Set<string>(), files: 0 };
      entry.paths.add(".");
      entry.files += 1;
      domains.set("root", entry);
    }
  }
  const rows: DomainRow[] = [];
  for (const [name, info] of domains) {
    if (info.files >= 2) {
      rows.push({ name, rootPaths: [...info.paths], fileCount: info.files });
    }
  }
  rows.sort((a, b) => b.fileCount - a.fileCount);
  return rows;
}

// Path comment: dirname/basename used from node:path at top of file to keep
// line-local reasoning consistent with the Python reference's os.path usage.
void dirname;
