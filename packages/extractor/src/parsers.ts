import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser } from "web-tree-sitter";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

let initialized = false;

async function ensureInitialized(): Promise<void> {
  if (initialized) return;
  // Point the runtime at the WASM binary shipped with the npm package so
  // we don't rely on the default (which assumes a browser/Emscripten path).
  // web-tree-sitter 0.26 renamed this binary (tree-sitter.wasm → web-tree-sitter.wasm).
  const wasmPath = require.resolve("web-tree-sitter/web-tree-sitter.wasm");
  await Parser.init({
    locateFile: () => wasmPath,
  });
  initialized = true;
}

// Grammar wasm is sourced from the official per-grammar packages, which ship
// prebuilt .wasm that is ABI-compatible with web-tree-sitter 0.26 (the legacy
// `tree-sitter-wasms` bundle is built against the 0.25-era ABI and fails
// Language.load on 0.26 — spec-292 dec-1).
const GRAMMAR_WASM: Record<string, string> = {
  python: "tree-sitter-python/tree-sitter-python.wasm",
  typescript: "tree-sitter-typescript/tree-sitter-typescript.wasm",
};

function grammarPath(name: string): string {
  const subpath = GRAMMAR_WASM[name];
  if (!subpath) throw new Error(`No grammar wasm registered for '${name}'`);
  return require.resolve(subpath);
}

let pyLanguage: Language | null = null;
let tsLanguage: Language | null = null;

export async function getPythonParser(): Promise<Parser> {
  await ensureInitialized();
  if (!pyLanguage) {
    const bytes = new Uint8Array(readFileSync(grammarPath("python")));
    pyLanguage = await Language.load(bytes);
  }
  const parser = new Parser();
  parser.setLanguage(pyLanguage);
  return parser;
}

export async function getTypeScriptParser(): Promise<Parser> {
  await ensureInitialized();
  if (!tsLanguage) {
    const bytes = new Uint8Array(readFileSync(grammarPath("typescript")));
    tsLanguage = await Language.load(bytes);
  }
  const parser = new Parser();
  parser.setLanguage(tsLanguage);
  return parser;
}

// Re-export so consumers can type their Node variables.
export type { Parser, Language } from "web-tree-sitter";

// Convenience: mirror the Python `node.text.decode("utf-8")` call.
// In web-tree-sitter the .text getter already yields a JS string.
