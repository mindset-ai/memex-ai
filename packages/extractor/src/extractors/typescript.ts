import { dirname, normalize, posix } from "node:path";
import type { Node, Parser } from "web-tree-sitter";
import { getTypeScriptParser } from "../parsers.ts";
import type {
  ExtractedCall,
  ExtractedImport,
  ExtractedSymbol,
} from "../types.ts";
import { buildSymbolIndex } from "./enclosing.ts";
import type { LanguageExtractor } from "./types.ts";

// ── TypeScript-specific noise names ──
// JS built-ins, array/string/object prototype methods, async, testing
// frameworks, Node/browser globals. No React hooks, no Drizzle / zod /
// library-specific names — those are caught by the external-import check
// at call-resolution time (see ingest.ts). This list is only for things
// every JS/TS codebase always has.
const TS_NOISE: ReadonlySet<string> = new Set([
  "console", "log", "warn", "error", "info", "debug",
  "setTimeout", "setInterval", "clearTimeout", "clearInterval",
  "parseInt", "parseFloat", "isNaN", "isFinite",
  "JSON", "parse", "stringify",
  "Math", "floor", "ceil", "round", "random", "abs", "min", "max",
  "Date", "now", "getTime", "toISOString",
  "Object", "keys", "values", "entries", "assign", "freeze",
  "Array", "from", "isArray",
  "String", "Number", "Boolean", "Symbol", "BigInt",
  "Set", "Map", "WeakMap", "WeakSet",
  "Promise", "resolve", "reject", "all", "race", "allSettled",
  "Error", "TypeError", "RangeError",
  "toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable",
  // Array methods
  "map", "filter", "reduce", "forEach", "find", "findIndex",
  "some", "every", "flat", "flatMap", "includes", "indexOf",
  "push", "pop", "shift", "unshift", "splice", "slice", "concat",
  "sort", "reverse", "join",
  // String methods
  "split", "trim", "trimStart", "trimEnd", "replace", "replaceAll",
  "startsWith", "endsWith", "match", "search",
  "toLowerCase", "toUpperCase", "substring", "charAt", "padStart",
  // Object/Map methods
  "get", "set", "has", "delete", "clear", "size",
  // Promise/async
  "then", "catch", "finally", "await",
  // Testing frameworks (universal to any JS/TS project)
  "describe", "it", "test", "expect", "beforeEach", "afterEach",
  "beforeAll", "afterAll", "jest", "vi", "mock", "fn", "spyOn",
  "toBe", "toEqual", "toHaveBeenCalled", "toHaveBeenCalledWith",
  "toThrow", "toBeDefined", "toBeNull", "toBeUndefined",
  "toContain", "toHaveLength", "toMatchObject",
  // Node/browser
  "require", "module", "exports",
  "fetch", "Response", "Headers", "Request",
  "addEventListener", "removeEventListener", "dispatchEvent",
  "createElement", "getElementById", "querySelector",
]);

function line(node: Node): number {
  return node.startPosition.row + 1;
}
function endLine(node: Node): number {
  return node.endPosition.row + 1;
}

function isExported(node: Node): boolean {
  const parent = node.parent;
  return parent !== null && parent.type === "export_statement";
}

function getJSDoc(node: Node): string | null {
  const prev = node.previousNamedSibling;
  if (prev && prev.type === "comment") {
    const text = prev.text;
    if (text.startsWith("/**")) {
      const chars = "/* \n";
      let start = 0;
      while (start < text.length && chars.includes(text[start]!)) start++;
      let end = text.length;
      while (end > start && chars.includes(text[end - 1]!)) end--;
      return text.slice(start, end).trim();
    }
  }
  return null;
}

export class TypeScriptExtractor implements LanguageExtractor {
  readonly language = "typescript" as const;
  readonly noiseNames = TS_NOISE;

  private cachedParser: Parser | null = null;

  async getParser(): Promise<Parser> {
    if (!this.cachedParser) this.cachedParser = await getTypeScriptParser();
    return this.cachedParser;
  }

  extractSymbols(root: Node): ExtractedSymbol[] {
    const symbols: ExtractedSymbol[] = [];
    const language = this.language;

    function extractFunction(node: Node, parentName: string | null, exported: boolean): ExtractedSymbol {
      const nameNode = node.childForFieldName("name");
      const name = nameNode ? nameNode.text : "<anonymous>";
      const paramsNode = node.childForFieldName("parameters");
      const params = paramsNode ? paramsNode.text : "()";
      const returnTypeNode = node.childForFieldName("return_type");
      const returnType = returnTypeNode ? returnTypeNode.text : "";
      let isAsync = false;
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (c && c.type === "async") {
          isAsync = true;
          break;
        }
      }
      return {
        name,
        kind: "function",
        parentName,
        signature: `${isAsync ? "async " : ""}function ${name}${params}${returnType}`,
        lineStart: line(node),
        lineEnd: endLine(node),
        isExported: exported,
        isAsync,
        language,
        docComment: getJSDoc(node),
      };
    }

    function extractArrowFunction(
      nameNode: Node,
      arrowNode: Node,
      declNode: Node,
      exported: boolean,
    ): ExtractedSymbol {
      const name = nameNode.text;
      const paramsNode = arrowNode.childForFieldName("parameters");
      const params = paramsNode ? paramsNode.text : "()";
      const returnTypeNode = arrowNode.childForFieldName("return_type");
      const returnType = returnTypeNode ? returnTypeNode.text : "";
      let isAsync = false;
      for (let i = 0; i < arrowNode.childCount; i++) {
        const c = arrowNode.child(i);
        if (c && c.type === "async") {
          isAsync = true;
          break;
        }
      }
      return {
        name,
        kind: "function",
        parentName: null,
        signature: `${isAsync ? "async " : ""}const ${name} = ${params}${returnType} => ...`,
        lineStart: line(declNode),
        lineEnd: endLine(declNode),
        isExported: exported,
        isAsync,
        language,
        docComment: null,
      };
    }

    function extractClass(node: Node, exported: boolean): ExtractedSymbol {
      const nameNode = node.childForFieldName("name");
      const name = nameNode ? nameNode.text : "<anonymous>";
      let heritage = "";
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (c && c.type === "class_heritage") heritage = " " + c.text;
      }
      return {
        name,
        kind: "class",
        parentName: null,
        signature: `class ${name}${heritage}`,
        lineStart: line(node),
        lineEnd: endLine(node),
        isExported: exported,
        isAsync: false,
        language,
        docComment: getJSDoc(node),
      };
    }

    function extractMethod(node: Node, parentName: string): ExtractedSymbol {
      const nameNode = node.childForFieldName("name");
      const name = nameNode ? nameNode.text : "<anonymous>";
      const paramsNode = node.childForFieldName("parameters");
      const params = paramsNode ? paramsNode.text : "()";
      const returnTypeNode = node.childForFieldName("return_type");
      const returnType = returnTypeNode ? returnTypeNode.text : "";
      let isAsync = false;
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (c && c.type === "async") {
          isAsync = true;
          break;
        }
      }
      return {
        name,
        kind: "method",
        parentName,
        signature: `${isAsync ? "async " : ""}${name}${params}${returnType}`,
        lineStart: line(node),
        lineEnd: endLine(node),
        isExported: false,
        isAsync,
        language,
        docComment: null,
      };
    }

    function extractInterface(node: Node, exported: boolean): ExtractedSymbol {
      const nameNode = node.childForFieldName("name");
      const name = nameNode ? nameNode.text : "<anonymous>";
      let extendsText = "";
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (c && c.type === "extends_type_clause") extendsText = " " + c.text;
      }
      return {
        name,
        kind: "interface",
        parentName: null,
        signature: `interface ${name}${extendsText}`,
        lineStart: line(node),
        lineEnd: endLine(node),
        isExported: exported,
        isAsync: false,
        language,
        docComment: getJSDoc(node),
      };
    }

    function extractTypeAlias(node: Node, exported: boolean): ExtractedSymbol {
      const nameNode = node.childForFieldName("name");
      const name = nameNode ? nameNode.text : "<anonymous>";
      const valueNode = node.childForFieldName("value");
      const valueText = valueNode ? valueNode.text.slice(0, 300) : "";
      return {
        name,
        kind: "type",
        parentName: null,
        signature: `type ${name} = ${valueText}`,
        lineStart: line(node),
        lineEnd: endLine(node),
        isExported: exported,
        isAsync: false,
        language,
        docComment: getJSDoc(node),
      };
    }

    function extractEnum(node: Node, exported: boolean): ExtractedSymbol {
      const nameNode = node.childForFieldName("name");
      const name = nameNode ? nameNode.text : "<anonymous>";
      const members: string[] = [];
      const body = node.childForFieldName("body");
      if (body) {
        for (let i = 0; i < body.childCount; i++) {
          const c = body.child(i);
          if (c && (c.type === "enum_assignment" || c.type === "property_identifier")) {
            members.push(c.text);
          }
        }
      }
      const shown = members.slice(0, 10).join(", ");
      const more = members.length > 10 ? "..." : "";
      return {
        name,
        kind: "enum",
        parentName: null,
        signature: `enum ${name} { ${shown}${more} }`,
        lineStart: line(node),
        lineEnd: endLine(node),
        isExported: exported,
        isAsync: false,
        language,
        docComment: null,
      };
    }

    function visit(node: Node, parentName: string | null): void {
      if (node.type === "function_declaration" || node.type === "generator_function_declaration") {
        symbols.push(extractFunction(node, parentName, isExported(node)));
      } else if (node.type === "lexical_declaration" && parentName === null) {
        for (let i = 0; i < node.childCount; i++) {
          const declarator = node.child(i);
          if (!declarator || declarator.type !== "variable_declarator") continue;
          const nameNode = declarator.childForFieldName("name");
          const valueNode = declarator.childForFieldName("value");
          if (!nameNode || !valueNode) continue;
          if (valueNode.type === "arrow_function") {
            symbols.push(extractArrowFunction(nameNode, valueNode, node, isExported(node)));
          } else {
            const name = nameNode.text;
            if (name === name.toUpperCase() || name.startsWith("DEFAULT_") || name.endsWith("_URL")) {
              const valueText = valueNode.text.slice(0, 200);
              symbols.push({
                name,
                kind: "constant",
                parentName: null,
                signature: `const ${name} = ${valueText}`,
                lineStart: line(node),
                lineEnd: endLine(node),
                isExported: isExported(node),
                isAsync: false,
                language,
                docComment: null,
              });
            }
          }
        }
      } else if (node.type === "class_declaration") {
        const classInfo = extractClass(node, isExported(node));
        symbols.push(classInfo);
        const body = node.childForFieldName("body");
        if (body) {
          for (let i = 0; i < body.childCount; i++) {
            const child = body.child(i);
            if (child && (child.type === "method_definition" || child.type === "public_field_definition")) {
              visit(child, classInfo.name);
            }
          }
        }
        return;
      } else if (node.type === "method_definition" && parentName) {
        symbols.push(extractMethod(node, parentName));
        return;
      } else if (node.type === "public_field_definition" && parentName) {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          const name = nameNode.text;
          const typeAnn = node.childForFieldName("type");
          const typeText = typeAnn ? typeAnn.text : "";
          symbols.push({
            name,
            kind: "field",
            parentName,
            signature: `${name}${typeText}`,
            lineStart: line(node),
            lineEnd: endLine(node),
            isExported: false,
            isAsync: false,
            language,
            docComment: null,
          });
        }
        return;
      } else if (node.type === "interface_declaration") {
        symbols.push(extractInterface(node, isExported(node)));
        const body = node.childForFieldName("body");
        if (body) {
          const ifaceNameNode = node.childForFieldName("name");
          const ifaceName = ifaceNameNode ? ifaceNameNode.text : "<anon>";
          for (let i = 0; i < body.childCount; i++) {
            const child = body.child(i);
            if (!child) continue;
            if (child.type === "property_signature" || child.type === "method_signature") {
              const propName = child.childForFieldName("name");
              if (propName) {
                const sigText = child.text.trim().replace(/;+$/, "");
                const kind = child.type === "method_signature" ? "method" : "field";
                symbols.push({
                  name: propName.text,
                  kind,
                  parentName: ifaceName,
                  signature: sigText,
                  lineStart: line(child),
                  lineEnd: endLine(child),
                  isExported: false,
                  isAsync: false,
                  language,
                  docComment: null,
                });
              }
            }
          }
        }
        return;
      } else if (node.type === "type_alias_declaration") {
        symbols.push(extractTypeAlias(node, isExported(node)));
        return;
      } else if (node.type === "enum_declaration") {
        symbols.push(extractEnum(node, isExported(node)));
        return;
      } else if (node.type === "export_statement") {
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child && child.type !== "export" && child.type !== "default" && child.type !== "export_clause") {
            visit(child, parentName);
          }
        }
        return;
      }

      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) visit(child, parentName);
      }
    }

    visit(root, null);
    return symbols;
  }

  extractImports(root: Node): ExtractedImport[] {
    const imports: ExtractedImport[] = [];
    for (let i = 0; i < root.childCount; i++) {
      const node = root.child(i);
      if (!node) continue;
      if (node.type === "import_statement") {
        const imp = this.parseImportStatement(node);
        if (imp) imports.push(imp);
      } else if (node.type === "export_statement") {
        for (let j = 0; j < node.childCount; j++) {
          const child = node.child(j);
          if (!child || child.type !== "export_clause") continue;
          let module: string | null = null;
          for (let s = 0; s < node.childCount; s++) {
            const sub = node.child(s);
            if (sub && sub.type === "string") {
              module = sub.text.slice(1, -1);
              break;
            }
          }
          if (!module) continue;
          const names: string[] = [];
          for (let s = 0; s < child.childCount; s++) {
            const spec = child.child(s);
            if (spec && spec.type === "export_specifier") {
              const nameNode = spec.childForFieldName("name");
              if (nameNode) names.push(nameNode.text);
            }
          }
          if (names.length > 0) imports.push({ module, names });
        }
      }
    }
    return imports;
  }

  private parseImportStatement(node: Node): ExtractedImport | null {
    let module: string | null = null;
    const names: string[] = [];
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (!child) continue;
      if (child.type === "string") {
        module = child.text.slice(1, -1);
      } else if (child.type === "import_clause") {
        for (let j = 0; j < child.childCount; j++) {
          const sub = child.child(j);
          if (!sub) continue;
          if (sub.type === "identifier") {
            names.push(sub.text);
          } else if (sub.type === "named_imports") {
            for (let k = 0; k < sub.childCount; k++) {
              const spec = sub.child(k);
              if (spec && spec.type === "import_specifier") {
                // Capture alias if present: `import { eq as equal }` binds
                // locally as `equal`, so we record `equal` (not `eq`).
                const aliasNode = spec.childForFieldName("alias");
                const nameNode = spec.childForFieldName("name");
                if (aliasNode) {
                  names.push(aliasNode.text);
                } else if (nameNode) {
                  names.push(nameNode.text);
                }
              }
            }
          } else if (sub.type === "namespace_import") {
            for (let k = 0; k < sub.childCount; k++) {
              const nsChild = sub.child(k);
              if (nsChild && nsChild.type === "identifier") names.push(nsChild.text);
            }
          }
        }
      }
    }
    if (module && names.length > 0) return { module, names };
    if (module) return { module, names: [] };
    return null;
  }

  extractCalls(root: Node, symbols: ExtractedSymbol[]): ExtractedCall[] {
    const calls: ExtractedCall[] = [];
    const index = buildSymbolIndex(symbols);
    function visit(node: Node): void {
      if (node.type === "call_expression") {
        const funcNode = node.childForFieldName("function");
        if (funcNode) {
          const callText = funcNode.text;
          const callName = callText.split(".").pop() ?? callText;
          const lineNo = line(node);
          const fromSymbol = index.findEnclosing(lineNo);
          if (fromSymbol) {
            calls.push({
              fromSymbolName: fromSymbol.name,
              toName: callName,
              fullCall: callText,
              lineNumber: lineNo,
            });
          }
        }
      } else if (node.type === "new_expression") {
        const constructor = node.childForFieldName("constructor");
        if (constructor) {
          const callName = constructor.text.split(".").pop() ?? constructor.text;
          const lineNo = line(node);
          const fromSymbol = index.findEnclosing(lineNo);
          if (fromSymbol) {
            calls.push({
              fromSymbolName: fromSymbol.name,
              toName: callName,
              fullCall: `new ${constructor.text}`,
              lineNumber: lineNo,
            });
          }
        }
      }
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) visit(child);
      }
    }
    visit(root);
    return calls;
  }

  resolveImport(moduleRaw: string, repoFilePaths: Set<string>, currentFile: string): string | null {
    if (!moduleRaw.startsWith(".")) return null;

    const currentDir = dirname(currentFile);
    const resolved = posix.normalize(posix.join(currentDir, moduleRaw));

    const candidates = [`${resolved}.ts`, `${resolved}.tsx`, `${resolved}/index.ts`, `${resolved}/index.tsx`];
    for (const candidate of candidates) {
      const norm = normalize(candidate);
      if (repoFilePaths.has(norm)) return norm;
      for (const filePath of repoFilePaths) {
        if (normalize(filePath) === norm || filePath.endsWith(norm)) return filePath;
      }
    }
    return null;
  }

  // TS class heritage is stored as a single `class_heritage` node containing
  // `extends Foo[, implements Bar]`. We only care about the `extends` clause.
  parseParentClassSignature(signature: string): string | null {
    const extendsIdx = signature.indexOf(" extends ");
    if (extendsIdx === -1) return null;
    const afterExtends = signature.slice(extendsIdx + " extends ".length).trim();
    // Stop at `implements`, `{`, `<`, or `,`
    const end = Math.min(
      ...[" implements ", "{", "<", ","]
        .map((s) => afterExtends.indexOf(s))
        .filter((i) => i !== -1)
        .concat([afterExtends.length]),
    );
    const parent = afterExtends.slice(0, end).trim();
    return parent || null;
  }
}
