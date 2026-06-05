import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import type { Language } from "./types.ts";

const SUPPORTED_EXTENSIONS = new Set([".py", ".ts", ".tsx"]);
const SKIP_DIR_NAMES = new Set(["venv", "__pycache__", "node_modules", ".git"]);

const EXT_TO_LANGUAGE: Record<string, Language> = {
  ".py": "python",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".go": "go",
  ".rs": "rust",
  ".dart": "dart",
};

export function detectLanguage(path: string): Language | null {
  return EXT_TO_LANGUAGE[extname(path).toLowerCase()] ?? null;
}

export function fileHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

const TEST_PATH_PATTERNS = ["test/", "tests/", "__tests__/", "spec/"];
const TEST_FILE_PATTERNS = ["test_", "_test.py", ".test.py", ".spec.py"];
const TEST_IMPORT_TOKENS = ["pytest", "unittest", "mock", "unittest.mock", "hypothesis"];

export function isTestFile(path: string, content: string): boolean {
  const lower = path.toLowerCase();
  if (TEST_PATH_PATTERNS.some((p) => lower.includes(p))) return true;
  const name = basename(lower);
  if (name.startsWith("test_") || name.endsWith("_test.py")) return true;
  if (TEST_FILE_PATTERNS.some((p) => name.includes(p))) return true;
  const head = content.split("\n").slice(0, 30).join("\n");
  return TEST_IMPORT_TOKENS.some((t) => head.includes(`import ${t}`) || head.includes(`from ${t}`));
}

export interface CollectedFile {
  relPath: string;
  absPath: string;
  content: string;
}

export function collectFiles(folderPaths: string[], basePath: string): CollectedFile[] {
  const files: CollectedFile[] = [];

  function walk(dir: string) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(".") || SKIP_DIR_NAMES.has(entry)) continue;
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile()) {
        const ext = extname(full).toLowerCase();
        if (!SUPPORTED_EXTENSIONS.has(ext)) continue;
        let content: string;
        try {
          content = readFileSync(full, "utf8");
        } catch {
          continue;
        }
        files.push({
          relPath: relative(basePath, full),
          absPath: full,
          content,
        });
      }
    }
  }

  for (const folder of folderPaths) walk(folder);
  return files;
}

export function commonBasePath(paths: string[]): string {
  if (paths.length === 1) return paths[0]!;
  const split = paths.map((p) => p.split("/"));
  const first = split[0]!;
  const out: string[] = [];
  for (let i = 0; i < first.length; i++) {
    const token = first[i];
    if (split.every((parts) => parts[i] === token)) {
      out.push(token!);
    } else {
      break;
    }
  }
  return out.join("/") || "/";
}
