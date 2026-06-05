import type { Language } from "../types.ts";
import { PythonExtractor } from "./python.ts";
import { TypeScriptExtractor } from "./typescript.ts";
import type { LanguageExtractor } from "./types.ts";

// Registry of language extractors. Adding a new language means:
//   1. Implement LanguageExtractor in extractors/<lang>.ts
//   2. Register it below
// No other file in the extractor needs to change — no ingest.ts branching,
// no shared noise-list mutation, no cross-language leakage.
const REGISTRY = new Map<Language, LanguageExtractor>([
  ["python", new PythonExtractor()],
  ["typescript", new TypeScriptExtractor()],
]);

export function getExtractor(language: Language | null): LanguageExtractor | null {
  if (!language) return null;
  return REGISTRY.get(language) ?? null;
}

export function registeredLanguages(): Language[] {
  return [...REGISTRY.keys()];
}

export type { LanguageExtractor } from "./types.ts";
