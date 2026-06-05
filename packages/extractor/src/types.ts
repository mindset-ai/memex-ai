// Shared shapes for extracted data, kept close to the Python reference's
// dict shapes so the differential test can compare 1:1.

export type Language = "python" | "typescript" | "javascript" | "go" | "rust" | "dart";

export type SymbolKind =
  | "function"
  | "class"
  | "method"
  | "interface"
  | "type"
  | "enum"
  | "constant"
  | "field";

export interface ExtractedSymbol {
  name: string;
  kind: SymbolKind;
  parentName: string | null;
  signature: string;
  lineStart: number;
  lineEnd: number;
  isExported: boolean;
  isAsync: boolean;
  language: Language;
  docComment: string | null;
}

export interface ExtractedImport {
  module: string;
  names: string[];
}

export interface ExtractedCall {
  fromSymbolName: string;
  toName: string;
  fullCall: string;
  lineNumber: number;
}

export interface ExtractedEndpoint {
  method: string;
  path: string;
  handlerName: string | null;
  lineNumber: number;
  framework: string;
}

export interface ExtractedPatterns {
  envVars: Set<string>;
  firestoreCollections: Set<string>;
  secrets: Set<string>;
}

export interface DepRecord {
  fromFileId: string;
  toFileId: string | null;
  kind: "internal" | "external";
}
