import { beforeAll, describe, expect, it } from "vitest";
import { PythonExtractor } from "./python.ts";

// Every test shares one parser (extractor caches it internally). Init is
// async because web-tree-sitter loads the grammar WASM lazily.
const extractor = new PythonExtractor();

async function parse(src: string) {
  const parser = await extractor.getParser();
  return parser.parse(src)!;
}

beforeAll(async () => {
  // Warm the parser so the first test doesn't pay the WASM-init hit.
  await extractor.getParser();
});

describe("PythonExtractor.extractSymbols", () => {
  it("captures top-level functions and async functions", async () => {
    const tree = await parse(`
def sync_fn(x):
    return x

async def async_fn(y):
    return y
`);
    const syms = extractor.extractSymbols(tree.rootNode);
    const names = syms.filter((s) => s.kind === "function").map((s) => s.name);
    expect(names).toEqual(["sync_fn", "async_fn"]);
    const asyncSym = syms.find((s) => s.name === "async_fn")!;
    expect(asyncSym.isAsync).toBe(true);
    expect(asyncSym.signature).toContain("async def");
  });

  it("captures classes and their methods (method kind, parentName)", async () => {
    const tree = await parse(`
class Foo(Bar):
    def method_one(self):
        pass
    def _private(self):
        pass
`);
    const syms = extractor.extractSymbols(tree.rootNode);
    const fooClass = syms.find((s) => s.kind === "class" && s.name === "Foo")!;
    expect(fooClass.signature).toContain("class Foo(Bar)");
    const m1 = syms.find((s) => s.name === "method_one")!;
    expect(m1.kind).toBe("method");
    expect(m1.parentName).toBe("Foo");
    expect(m1.isExported).toBe(true);
    const priv = syms.find((s) => s.name === "_private")!;
    expect(priv.isExported).toBe(false);
  });

  it("captures top-level UPPER_CASE constants", async () => {
    const tree = await parse(`
MAX_RETRIES = 5
DEFAULT_URL = "https://example.com"
SOME_KEY = "x"
should_not_capture = 1
`);
    const syms = extractor.extractSymbols(tree.rootNode);
    const consts = syms.filter((s) => s.kind === "constant").map((s) => s.name);
    expect(consts).toContain("MAX_RETRIES");
    expect(consts).toContain("DEFAULT_URL");
    expect(consts).toContain("SOME_KEY");
    expect(consts).not.toContain("should_not_capture");
  });

  it("captures class fields assigned a value", async () => {
    // Assignment-style fields (`name = value`) are reliably emitted as
    // expression_statement > assignment by tree-sitter-python. Bare type
    // annotations (`name: str`) emit different AST shapes across grammar
    // versions and are covered by the integration test on real
    // Pydantic/dataclass files rather than synthesised snippets.
    const tree = await parse(`
class Model:
    default_name = "unknown"
    max_retries = 5
`);
    const syms = extractor.extractSymbols(tree.rootNode);
    const fields = syms.filter((s) => s.kind === "field" && s.parentName === "Model");
    const names = fields.map((f) => f.name);
    expect(names).toContain("default_name");
    expect(names).toContain("max_retries");
  });

  it("captures the docstring of a function or class", async () => {
    const tree = await parse(`
def foo():
    """Does stuff."""
    pass
`);
    const syms = extractor.extractSymbols(tree.rootNode);
    const foo = syms.find((s) => s.name === "foo")!;
    expect(foo.docComment).toBe("Does stuff.");
  });
});

describe("PythonExtractor.extractImports", () => {
  it("captures `import X` and picks the last dotted segment as the name", async () => {
    const tree = await parse(`import os\nimport logging\nimport foo.bar.baz\n`);
    const imports = extractor.extractImports(tree.rootNode);
    expect(imports).toEqual([
      { module: "os", names: ["os"] },
      { module: "logging", names: ["logging"] },
      { module: "foo.bar.baz", names: ["baz"] },
    ]);
  });

  it("captures `from X import A, B` excluding the module itself (the bug I fixed)", async () => {
    const tree = await parse(`from auth import authenticate, AuthError\nfrom fastapi import APIRouter, Header\n`);
    const imports = extractor.extractImports(tree.rootNode);
    // The fix was: child.id !== moduleId, not child !== moduleNode.
    // Regression guard: 'auth' itself must NOT appear in names.
    expect(imports[0]).toEqual({ module: "auth", names: ["authenticate", "AuthError"] });
    expect(imports[1]).toEqual({ module: "fastapi", names: ["APIRouter", "Header"] });
  });

  it("captures aliased imports by alias name", async () => {
    const tree = await parse(`from auth import authenticate as auth_fn\n`);
    const imports = extractor.extractImports(tree.rootNode);
    expect(imports[0]?.names).toContain("auth_fn");
  });
});

describe("PythonExtractor.extractEndpoints", () => {
  it("captures FastAPI router endpoints with their handlers", async () => {
    const tree = await parse(`
from fastapi import APIRouter
router = APIRouter()

@router.get("/health")
async def health_check():
    return {"ok": True}

@router.post("/users")
def create_user(body):
    return body
`);
    const endpoints = extractor.extractEndpoints(tree.rootNode);
    expect(endpoints).toHaveLength(2);
    expect(endpoints[0]).toMatchObject({
      method: "GET",
      path: "/health",
      handlerName: "health_check",
      framework: "fastapi",
    });
    expect(endpoints[1]).toMatchObject({
      method: "POST",
      path: "/users",
      handlerName: "create_user",
      framework: "fastapi",
    });
  });

  it("captures Flask blueprint.route with methods kw-arg", async () => {
    const tree = await parse(`
from flask import Blueprint
bp = Blueprint("x", __name__)

@bp.route("/thing", methods=["POST"])
def handle_thing():
    return ""
`);
    const endpoints = extractor.extractEndpoints(tree.rootNode);
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]).toMatchObject({
      method: "POST",
      path: "/thing",
      handlerName: "handle_thing",
      framework: "flask",
    });
  });
});

describe("PythonExtractor.parseParentClassSignature", () => {
  it("extracts the first base class", () => {
    expect(extractor.parseParentClassSignature("class Foo(Bar)")).toBe("Bar");
    expect(extractor.parseParentClassSignature("class Foo(Bar, Baz)")).toBe("Bar");
  });
  it("returns null for classes without an explicit parent", () => {
    expect(extractor.parseParentClassSignature("class Foo")).toBeNull();
    expect(extractor.parseParentClassSignature("class Foo()")).toBeNull();
  });
  it("ignores keyword-only first args (metaclass=X)", () => {
    expect(extractor.parseParentClassSignature("class Foo(metaclass=ABCMeta)")).toBeNull();
  });
});

describe("PythonExtractor.resolveImport (locality-aware)", () => {
  const files = new Set([
    "packages/a/utils.py",
    "packages/a/main.py",
    "packages/b/utils.py",
    "packages/b/main.py",
    "packages/c/__init__.py",
    "packages/c/nested/thing.py",
  ]);

  it("returns null for stdlib modules (no false substring matches)", () => {
    // `logging` used to match a file called test_enrichment_logging.py via
    // endsWith. The stdlib exclusion prevents that.
    expect(
      extractor.resolveImport("logging", new Set(["src/test_enrichment_logging.py"]), "src/main.py"),
    ).toBeNull();
  });

  it("resolves to the file in the importer's package, not a sibling package (the HIGH 4 fix)", () => {
    // From packages/a/main.py, `from utils import x` must resolve to
    // packages/a/utils.py, NOT packages/b/utils.py. The old endsWith-only
    // resolver was monorepo-ambiguous here.
    const resolved = extractor.resolveImport("utils", files, "packages/a/main.py");
    expect(resolved).toBe("packages/a/utils.py");
  });

  it("walks up the package tree to find the nearest match", () => {
    // From packages/b/main.py: first tries packages/b/utils.py, finds it.
    expect(extractor.resolveImport("utils", files, "packages/b/main.py")).toBe(
      "packages/b/utils.py",
    );
  });

  it("resolves package imports via __init__.py", () => {
    // An external file importing 'packages.c' resolves to __init__.py.
    expect(
      extractor.resolveImport(
        "packages.c",
        files,
        "elsewhere/caller.py",
      ),
    ).toBe("packages/c/__init__.py");
  });

  it("returns null when no file matches anywhere", () => {
    expect(extractor.resolveImport("nonexistent_pkg", files, "packages/a/main.py")).toBeNull();
  });
});
