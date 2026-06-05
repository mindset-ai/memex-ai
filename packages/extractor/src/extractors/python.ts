import type { Node, Parser } from "web-tree-sitter";
import { getPythonParser } from "../parsers.ts";
import type {
  ExtractedCall,
  ExtractedEndpoint,
  ExtractedImport,
  ExtractedPatterns,
  ExtractedSymbol,
} from "../types.ts";
import { buildSymbolIndex } from "./enclosing.ts";
import type { LanguageExtractor } from "./types.ts";

// ── Python stdlib module names (for import resolution) ──
// `sys.stdlib_module_names` equivalent. Imports whose top-level module is in
// this set resolve to null (external), never to an internal filename that
// happens to contain the name (fixes the `import logging` → `test_logging.py`
// bug the POC had).
const STDLIB: ReadonlySet<string> = new Set([
  "_thread", "abc", "aifc", "argparse", "array", "ast", "asynchat", "asyncio",
  "asyncore", "atexit", "base64", "bdb", "binascii", "binhex", "bisect",
  "builtins", "bz2", "calendar", "cgi", "cgitb", "chunk", "cmath", "cmd",
  "code", "codecs", "codeop", "collections", "colorsys", "compileall",
  "concurrent", "configparser", "contextlib", "contextvars", "copy",
  "copyreg", "cProfile", "crypt", "csv", "ctypes", "curses", "dataclasses",
  "datetime", "dbm", "decimal", "difflib", "dis", "distutils", "doctest",
  "email", "encodings", "enum", "errno", "faulthandler", "fcntl", "filecmp",
  "fileinput", "fnmatch", "fractions", "ftplib", "functools", "gc", "getopt",
  "getpass", "gettext", "glob", "grp", "gzip", "hashlib", "heapq", "hmac",
  "html", "http", "idlelib", "imaplib", "imghdr", "imp", "importlib",
  "inspect", "io", "ipaddress", "itertools", "json", "keyword", "lib2to3",
  "linecache", "locale", "logging", "lzma", "mailbox", "mailcap", "marshal",
  "math", "mimetypes", "mmap", "modulefinder", "multiprocessing", "netrc",
  "nis", "nntplib", "numbers", "operator", "optparse", "os", "ossaudiodev",
  "pathlib", "pdb", "pickle", "pickletools", "pipes", "pkgutil", "platform",
  "plistlib", "poplib", "posix", "posixpath", "pprint", "profile", "pstats",
  "pty", "pwd", "py_compile", "pyclbr", "pydoc", "queue", "quopri", "random",
  "re", "readline", "reprlib", "resource", "rlcompleter", "runpy", "sched",
  "secrets", "select", "selectors", "shelve", "shlex", "shutil", "signal",
  "site", "smtpd", "smtplib", "sndhdr", "socket", "socketserver", "sqlite3",
  "ssl", "stat", "statistics", "string", "stringprep", "struct", "subprocess",
  "sunau", "symtable", "sys", "sysconfig", "syslog", "tabnanny", "tarfile",
  "telnetlib", "tempfile", "termios", "test", "textwrap", "threading", "time",
  "timeit", "tkinter", "token", "tokenize", "tomllib", "trace", "traceback",
  "tracemalloc", "tty", "turtle", "turtledemo", "types", "typing",
  "unicodedata", "unittest", "urllib", "uu", "uuid", "venv", "warnings",
  "wave", "weakref", "webbrowser", "winreg", "winsound", "wsgiref", "xdrlib",
  "xml", "xmlrpc", "zipapp", "zipfile", "zipimport", "zlib",
  "typing_extensions",
]);

// ── Python-specific noise names (NOT shared with other languages) ──
const PY_NOISE: ReadonlySet<string> = new Set([
  // builtins
  "len", "str", "int", "float", "bool", "list", "dict", "set", "tuple",
  "print", "range", "enumerate", "zip", "map", "filter", "sorted", "reversed",
  "isinstance", "issubclass", "hasattr", "getattr", "setattr", "delattr",
  "type", "id", "hash", "repr", "abs", "round", "min", "max", "sum",
  "any", "all", "next", "iter", "super", "property", "classmethod",
  "staticmethod", "open", "input", "format", "chr", "ord", "hex", "oct", "bin",
  "ValueError", "TypeError", "KeyError", "IndexError", "AttributeError",
  "RuntimeError", "Exception", "StopIteration", "NotImplementedError",
  "OSError", "IOError", "FileNotFoundError", "PermissionError",
  // str/list/dict methods
  "append", "extend", "insert", "pop", "remove", "clear", "copy",
  "get", "keys", "values", "items", "update", "setdefault",
  "strip", "lstrip", "rstrip", "split", "rsplit", "join",
  "replace", "find", "rfind", "index", "rindex", "count",
  "startswith", "endswith", "upper", "lower", "title", "capitalize",
  "encode", "decode", "format_map",
  "add", "discard", "union", "intersection", "difference",
  "sort", "reverse",
  // common stdlib
  "dumps", "loads", "now", "sleep", "getenv", "b64encode", "b64decode",
  "urlencode", "urljoin", "urlparse", "makedirs", "exists", "abspath",
  "deepcopy", "wraps", "lru_cache", "partial", "reduce",
  "compile", "match", "search", "sub", "findall",
  "time", "datetime", "timedelta", "date",
  // logging
  "info", "error", "warning", "debug", "critical", "exception",
  "getLogger", "basicConfig",
  // testing
  "MagicMock", "Mock", "patch", "call", "ANY",
  "assert_called_once", "assert_called_once_with", "assert_called_with",
  "assert_not_called", "assert_called", "assert_has_calls",
  "assertEqual", "assertRaises", "assertTrue", "assertFalse",
  "assertIsNone", "assertIsNotNone", "assertIn", "assertNotIn",
  "fixture", "parametrize", "mark", "raises", "approx",
  // Firestore/GCP object methods
  "collection", "document", "to_dict", "where", "stream", "get_all",
  "order_by", "limit", "offset", "select", "batch",
  // HTTP/response methods
  "json", "text", "status_code", "headers", "raise_for_status",
  "JSONResponse", "Response", "Header", "Request",
]);

const ROUTE_PATTERNS: ReadonlySet<string> = new Set(["router", "app", "blueprint", "bp"]);
const HTTP_METHODS: ReadonlySet<string> = new Set([
  "get", "post", "put", "delete", "patch", "head", "options",
]);

// ── Helpers ──────────────────────────────────────

// Python's str.strip("\"'") removes any combination of quote chars from
// both ends. JS .trim() only handles whitespace, so replicate.
function stripChars(s: string, chars: string): string {
  let start = 0;
  while (start < s.length && chars.includes(s[start]!)) start++;
  let end = s.length;
  while (end > start && chars.includes(s[end - 1]!)) end--;
  return s.slice(start, end);
}

function line(node: Node): number {
  return node.startPosition.row + 1;
}
function endLine(node: Node): number {
  return node.endPosition.row + 1;
}

// ── Python extractor class ───────────────────────

export class PythonExtractor implements LanguageExtractor {
  readonly language = "python" as const;
  readonly noiseNames = PY_NOISE;

  private cachedParser: Parser | null = null;

  async getParser(): Promise<Parser> {
    if (!this.cachedParser) this.cachedParser = await getPythonParser();
    return this.cachedParser;
  }

  extractSymbols(root: Node): ExtractedSymbol[] {
    const symbols: ExtractedSymbol[] = [];
    const language = this.language;

    function extractFunction(node: Node, parentName: string | null): ExtractedSymbol {
      const nameNode = node.childForFieldName("name");
      const name = nameNode ? nameNode.text : "<anonymous>";
      const paramsNode = node.childForFieldName("parameters");
      const params = paramsNode ? paramsNode.text : "()";
      const returnNode = node.childForFieldName("return_type");
      const returnType = returnNode ? ` -> ${returnNode.text}` : "";

      const sourceLine = node.text.split("\n")[0] ?? "";
      const isAsync = sourceLine.includes("async def");

      let docComment: string | null = null;
      const body = node.childForFieldName("body");
      if (body && body.childCount > 0) {
        const first = body.child(0);
        if (first && first.type === "expression_statement" && first.childCount > 0) {
          const expr = first.child(0);
          if (expr && expr.type === "string") {
            docComment = stripChars(expr.text, "\"'").trim();
          }
        }
      }

      const kind = parentName ? "method" : "function";
      return {
        name,
        kind,
        parentName,
        signature: `${isAsync ? "async " : ""}def ${name}${params}${returnType}`,
        lineStart: line(node),
        lineEnd: endLine(node),
        isExported: !name.startsWith("_"),
        isAsync,
        language,
        docComment,
      };
    }

    function extractClass(node: Node): ExtractedSymbol {
      const nameNode = node.childForFieldName("name");
      const name = nameNode ? nameNode.text : "<anonymous>";
      const supers = node.childForFieldName("superclasses");
      const bases = supers ? supers.text : "";

      let docComment: string | null = null;
      const body = node.childForFieldName("body");
      if (body && body.childCount > 0) {
        const first = body.child(0);
        if (first && first.type === "expression_statement" && first.childCount > 0) {
          const expr = first.child(0);
          if (expr && expr.type === "string") {
            docComment = stripChars(expr.text, "\"'").trim();
          }
        }
      }

      return {
        name,
        kind: "class",
        parentName: null,
        signature: `class ${name}${bases}`,
        lineStart: line(node),
        lineEnd: endLine(node),
        isExported: !name.startsWith("_"),
        isAsync: false,
        language,
        docComment,
      };
    }

    function visit(node: Node, parentName: string | null): void {
      if (node.type === "function_definition") {
        symbols.push(extractFunction(node, parentName));
      } else if (node.type === "class_definition") {
        const classInfo = extractClass(node);
        symbols.push(classInfo);
        const body = node.childForFieldName("body");
        if (body) {
          // First pass: class-level fields.
          for (let i = 0; i < body.childCount; i++) {
            const child = body.child(i);
            if (!child) continue;
            if (child.type === "expression_statement") {
              const expr = child.childCount > 0 ? child.child(0) : null;
              if (expr && expr.type === "assignment") {
                const left = expr.childForFieldName("left");
                const right = expr.childForFieldName("right");
                if (left && right && left.type === "identifier") {
                  const fieldName = left.text;
                  const fieldValue = right.text.slice(0, 200);
                  symbols.push({
                    name: fieldName,
                    kind: "field",
                    parentName: classInfo.name,
                    signature: `${fieldName} = ${fieldValue}`,
                    lineStart: line(child),
                    lineEnd: endLine(child),
                    isExported: !fieldName.startsWith("_"),
                    isAsync: false,
                    language,
                    docComment: null,
                  });
                }
              }
            }
            if (child.type === "expression_statement" && child.childCount > 0) {
              const expr = child.child(0);
              if (expr && expr.type === "type" && expr.childCount >= 1) {
                const annotationText = expr.text;
                const colonIdx = annotationText.indexOf(":");
                if (colonIdx > 0) {
                  const fieldName = annotationText.slice(0, colonIdx).trim();
                  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(fieldName)) {
                    symbols.push({
                      name: fieldName,
                      kind: "field",
                      parentName: classInfo.name,
                      signature: annotationText.trim(),
                      lineStart: line(child),
                      lineEnd: endLine(child),
                      isExported: !fieldName.startsWith("_"),
                      isAsync: false,
                      language,
                      docComment: null,
                    });
                  }
                }
              }
            }
          }
          // Second pass: methods.
          for (let i = 0; i < body.childCount; i++) {
            const child = body.child(i);
            if (child) visit(child, classInfo.name);
          }
        }
        return;
      } else if (node.type === "decorated_definition") {
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child) visit(child, parentName);
        }
        return;
      } else if (node.type === "expression_statement" && parentName === null) {
        const expr = node.childCount > 0 ? node.child(0) : null;
        if (expr && expr.type === "assignment") {
          const left = expr.childForFieldName("left");
          const right = expr.childForFieldName("right");
          if (left && right && left.type === "identifier") {
            const name = left.text;
            if (
              name === name.toUpperCase() ||
              name.startsWith("DEFAULT_") ||
              name.endsWith("_URL") ||
              name.endsWith("_KEY")
            ) {
              const valueText = right.text.slice(0, 200);
              symbols.push({
                name,
                kind: "constant",
                parentName: null,
                signature: `${name} = ${valueText}`,
                lineStart: line(node),
                lineEnd: endLine(node),
                isExported: !name.startsWith("_"),
                isAsync: false,
                language,
                docComment: null,
              });
            }
          }
        }
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
        for (let j = 0; j < node.childCount; j++) {
          const child = node.child(j);
          if (child && child.type === "dotted_name") {
            const module = child.text;
            imports.push({ module, names: [module.split(".").pop() ?? module] });
          }
        }
      } else if (node.type === "import_from_statement") {
        const moduleNode = node.childForFieldName("module_name");
        const module = moduleNode ? moduleNode.text : "";
        const moduleId = moduleNode ? moduleNode.id : null;
        const names: string[] = [];
        for (let j = 0; j < node.childCount; j++) {
          const child = node.child(j);
          if (!child) continue;
          if (child.type === "dotted_name" && child.id !== moduleId) {
            names.push(child.text);
          } else if (child.type === "aliased_import") {
            // `from X import Y as Z` — the locally-bound name is Z, not Y.
            // Python call sites reference the alias, so record it.
            const aliasNode = child.childForFieldName("alias");
            const nameNode = child.childForFieldName("name");
            if (aliasNode) names.push(aliasNode.text);
            else if (nameNode) names.push(nameNode.text);
          }
        }
        if (names.length === 0 && module) {
          names.push(module.split(".").pop() ?? module);
        }
        imports.push({ module, names });
      }
    }
    return imports;
  }

  extractCalls(root: Node, symbols: ExtractedSymbol[]): ExtractedCall[] {
    const calls: ExtractedCall[] = [];
    const index = buildSymbolIndex(symbols);
    function visit(node: Node): void {
      if (node.type === "call") {
        const funcNode = node.childForFieldName("function");
        if (funcNode) {
          const callText = funcNode.text;
          const parts = callText.split(".");
          const callName = parts[parts.length - 1] ?? callText;
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
      }
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) visit(child);
      }
    }
    visit(root);
    return calls;
  }

  extractPatterns(root: Node): ExtractedPatterns {
    const patterns: ExtractedPatterns = {
      envVars: new Set(),
      firestoreCollections: new Set(),
      secrets: new Set(),
    };
    function visit(node: Node): void {
      if (node.type === "call") {
        const funcNode = node.childForFieldName("function");
        if (funcNode) {
          const callText = funcNode.text;
          const argsNode = node.childForFieldName("arguments");
          if (argsNode) {
            let firstArg: string | null = null;
            for (let i = 0; i < argsNode.childCount; i++) {
              const child = argsNode.child(i);
              if (!child) continue;
              if (child.type === "string") {
                firstArg = stripChars(child.text, "\"'");
                break;
              } else if (child.type === "keyword_argument") {
                const val = child.childForFieldName("value");
                if (val && val.type === "string") {
                  firstArg = stripChars(val.text, "\"'");
                  break;
                }
              }
            }
            if (firstArg) {
              if (
                callText.includes("environ.get") ||
                callText.includes("getenv") ||
                callText.includes("environ[")
              ) {
                patterns.envVars.add(firstArg);
              } else if (callText.endsWith(".collection") || callText === "collection") {
                patterns.firestoreCollections.add(firstArg);
              } else {
                const lower = callText.toLowerCase();
                if (lower.includes("secret") && (lower.includes("access") || lower.includes("get"))) {
                  patterns.secrets.add(firstArg);
                }
              }
            }
          }
        }
      }
      if (node.type === "subscript") {
        const valueNode = node.childForFieldName("value");
        const subscriptNode = node.childForFieldName("subscript");
        if (valueNode && subscriptNode) {
          if (valueNode.text.includes("environ") && subscriptNode.type === "string") {
            patterns.envVars.add(stripChars(subscriptNode.text, "\"'"));
          }
        }
      }
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) visit(child);
      }
    }
    visit(root);
    return patterns;
  }

  extractEndpoints(root: Node): ExtractedEndpoint[] {
    const endpoints: ExtractedEndpoint[] = [];
    for (let i = 0; i < root.childCount; i++) {
      const node = root.child(i);
      if (!node || node.type !== "decorated_definition") continue;

      for (let j = 0; j < node.childCount; j++) {
        const deco = node.child(j);
        if (!deco || deco.type !== "decorator") continue;

        for (let k = 0; k < deco.childCount; k++) {
          const call = deco.child(k);
          if (!call || call.type !== "call") continue;

          const attrNode = call.childForFieldName("function");
          if (!attrNode || attrNode.type !== "attribute") continue;

          const parts = attrNode.text.split(".");
          if (parts.length !== 2) continue;
          const [objName, methodName] = [parts[0]!, parts[1]!];

          if (!ROUTE_PATTERNS.has(objName.toLowerCase())) continue;

          const argsNode = call.childForFieldName("arguments");
          if (!argsNode) continue;

          let path: string | null = null;
          for (let a = 0; a < argsNode.childCount; a++) {
            const arg = argsNode.child(a);
            if (!arg) continue;
            if (arg.type === "string") {
              path = stripChars(arg.text, "\"'");
              break;
            }
            if (arg.type === "concatenated_string") {
              const pieces: string[] = [];
              for (let s = 0; s < arg.childCount; s++) {
                const piece = arg.child(s);
                if (piece && piece.type === "string") pieces.push(stripChars(piece.text, "\"'"));
              }
              path = pieces.join("");
              break;
            }
          }
          if (!path) continue;

          let httpMethod: string | null = null;
          const methodLower = methodName.toLowerCase();
          if (HTTP_METHODS.has(methodLower)) {
            httpMethod = methodName.toUpperCase();
          } else if (methodLower === "route") {
            httpMethod = "GET";
            for (let a = 0; a < argsNode.childCount; a++) {
              const arg = argsNode.child(a);
              if (!arg || arg.type !== "keyword_argument") continue;
              const key = arg.childForFieldName("name");
              if (!key || key.text !== "methods") continue;
              const val = arg.childForFieldName("value");
              if (!val) continue;
              const upper = val.text.toUpperCase();
              for (const m of HTTP_METHODS) {
                if (upper.includes(m.toUpperCase())) {
                  httpMethod = m.toUpperCase();
                  break;
                }
              }
            }
          } else if (methodLower === "api_route") {
            httpMethod = "GET";
          } else {
            continue;
          }

          let handlerName: string | null = null;
          for (let s = 0; s < node.childCount; s++) {
            const sibling = node.child(s);
            if (sibling && sibling.type === "function_definition") {
              const nameNode = sibling.childForFieldName("name");
              if (nameNode) handlerName = nameNode.text;
              break;
            }
          }

          const framework = objName === "router" || objName === "app" ? "fastapi" : "flask";

          endpoints.push({
            method: httpMethod,
            path,
            handlerName,
            lineNumber: line(deco),
            framework,
          });
        }
      }
    }
    return endpoints;
  }

  resolveImport(module: string, repoFilePaths: Set<string>, currentFile: string): string | null {
    const topLevel = module.split(".")[0]!;
    if (STDLIB.has(topLevel)) return null;

    const parts = module.replaceAll(".", "/");
    const candidates = [`${parts}.py`, `${parts}/__init__.py`];

    // Python resolves imports relative to the nearest package root, not
    // by fuzzy substring match. Walk up from the current file's directory;
    // at each level, check if any candidate exists exactly at that prefix.
    // This fixes the monorepo hazard where `from utils import foo` in
    // `packages/a/main.py` could match `packages/b/utils.py` under the
    // old endsWith-only resolver.
    //
    // Segments of currentFile: ["packages", "a", "foo", "main.py"]
    const currentDir = currentFile.split("/").slice(0, -1);
    for (let depth = currentDir.length; depth >= 0; depth--) {
      const prefix = currentDir.slice(0, depth).join("/");
      for (const candidate of candidates) {
        const full = prefix ? `${prefix}/${candidate}` : candidate;
        if (repoFilePaths.has(full)) return full;
      }
    }

    // Final fallback: any file ending with the candidate. Retained only so
    // cases without a package __init__.py (legacy Python layouts) still
    // resolve. Yields at most false positives in pathological monorepos —
    // but never crosses the STDLIB boundary because we bailed above.
    for (const candidate of candidates) {
      for (const filePath of repoFilePaths) {
        if (filePath.endsWith(`/${candidate}`) || filePath === candidate) return filePath;
      }
    }
    return null;
  }

  // Python class signatures: `class Foo(Bar)` → 'Bar'. `class Foo` → null.
  parseParentClassSignature(signature: string): string | null {
    if (!signature.includes("(")) return null;
    const parenStart = signature.indexOf("(");
    const parenEnd = signature.lastIndexOf(")");
    if (parenEnd < parenStart) return null;
    const bases = signature.slice(parenStart + 1, parenEnd).trim();
    if (!bases) return null;
    const firstBase = bases.split(",")[0]!.trim();
    if (firstBase.includes("=")) return null;
    return firstBase || null;
  }
}
