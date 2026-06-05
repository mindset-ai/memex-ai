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
  const wasmPath = require.resolve("web-tree-sitter/tree-sitter.wasm");
  await Parser.init({
    locateFile: () => wasmPath,
  });
  initialized = true;
}

function grammarPath(name: string): string {
  return require.resolve(`tree-sitter-wasms/out/tree-sitter-${name}.wasm`);
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
