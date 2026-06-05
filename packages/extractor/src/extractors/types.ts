import type { Parser, Node } from "web-tree-sitter";
import type {
  ExtractedCall,
  ExtractedEndpoint,
  ExtractedImport,
  ExtractedPatterns,
  ExtractedSymbol,
  Language,
} from "../types.ts";

// Every language plugs into the extractor through this single interface.
// Adding a new language means implementing it; no other file in the
// extractor needs to change. The registry (extractors/index.ts) dispatches
// on `Language`, so language-specific logic never leaks into ingest.ts,
// services, or the meta-layer.
export interface LanguageExtractor {
  readonly language: Language;

  // Names this language considers "noise" — builtins, stdlib methods,
  // prototype methods, framework testing helpers. Used by
  // markNoiseCalls, which MUST be called scoped to this language's files.
  readonly noiseNames: ReadonlySet<string>;

  // Lazily-constructed tree-sitter parser. Called once per ingestion.
  getParser(): Promise<Parser>;

  // Structural extraction. All receive the parse tree's root node.
  extractSymbols(root: Node): ExtractedSymbol[];
  extractImports(root: Node): ExtractedImport[];
  extractCalls(root: Node, symbols: ExtractedSymbol[]): ExtractedCall[];

  // Optional per-language features. If a language doesn't do HTTP routes
  // or environment/secret extraction, the implementation returns [] / empty.
  extractEndpoints?(root: Node): ExtractedEndpoint[];
  extractPatterns?(root: Node): ExtractedPatterns;

  // Resolve an import path to a file path inside the repo, or null if the
  // import is external (library package). Python: walk module dots.
  // TypeScript: relative path resolution with .ts / .tsx / /index.ts.
  resolveImport(module: string, repoFilePaths: Set<string>, currentFile: string): string | null;

  // Extract the first parent class name from this language's class
  // signature. Returns null if the class has no parent or parent parsing
  // doesn't apply. Called from services/calls.ts scoped to this language's
  // classes only — never cross-language.
  parseParentClassSignature(signature: string): string | null;
}
