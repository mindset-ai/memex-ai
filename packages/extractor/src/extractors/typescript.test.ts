import { beforeAll, describe, expect, it } from "vitest";
import { TypeScriptExtractor } from "./typescript.ts";

const extractor = new TypeScriptExtractor();

async function parse(src: string) {
  const parser = await extractor.getParser();
  return parser.parse(src)!;
}

beforeAll(async () => {
  await extractor.getParser();
});

describe("TypeScriptExtractor.extractSymbols", () => {
  it("captures exported and non-exported functions", async () => {
    const tree = await parse(`
export function pub() { return 1 }
function priv() { return 2 }
`);
    const syms = extractor.extractSymbols(tree.rootNode);
    const pub = syms.find((s) => s.name === "pub")!;
    const priv = syms.find((s) => s.name === "priv")!;
    expect(pub.isExported).toBe(true);
    expect(priv.isExported).toBe(false);
  });

  it("captures classes, methods (with parentName), and interface members", async () => {
    const tree = await parse(`
export class Greeter {
  greet(name: string): string { return name }
}
export interface User {
  name: string;
  getAge(): number;
}
`);
    const syms = extractor.extractSymbols(tree.rootNode);
    const greeter = syms.find((s) => s.kind === "class" && s.name === "Greeter")!;
    expect(greeter.isExported).toBe(true);

    const greet = syms.find((s) => s.name === "greet")!;
    expect(greet.kind).toBe("method");
    expect(greet.parentName).toBe("Greeter");

    const user = syms.find((s) => s.kind === "interface" && s.name === "User")!;
    expect(user.isExported).toBe(true);

    // Interface property + method signature captured as field and method
    const name = syms.find((s) => s.name === "name" && s.parentName === "User");
    const getAge = syms.find((s) => s.name === "getAge" && s.parentName === "User");
    expect(name?.kind).toBe("field");
    expect(getAge?.kind).toBe("method");
  });

  it("captures type aliases and enums", async () => {
    const tree = await parse(`
export type Id = string;
export enum Color { Red, Green, Blue }
`);
    const syms = extractor.extractSymbols(tree.rootNode);
    const id = syms.find((s) => s.name === "Id")!;
    expect(id.kind).toBe("type");
    const color = syms.find((s) => s.name === "Color")!;
    expect(color.kind).toBe("enum");
    expect(color.signature).toContain("Red");
  });

  it("captures const arrow functions as functions", async () => {
    const tree = await parse(`export const handler = async (req: Request) => { return req }`);
    const syms = extractor.extractSymbols(tree.rootNode);
    const h = syms.find((s) => s.name === "handler")!;
    expect(h.kind).toBe("function");
    expect(h.isAsync).toBe(true);
    expect(h.isExported).toBe(true);
  });
});

describe("TypeScriptExtractor.extractImports", () => {
  it("captures named imports", async () => {
    const tree = await parse(`import { foo, bar } from "./utils";`);
    const imports = extractor.extractImports(tree.rootNode);
    expect(imports).toEqual([{ module: "./utils", names: ["foo", "bar"] }]);
  });

  it("preserves alias bindings — import { eq as equal } records `equal`", async () => {
    // D2 in the FEAT.md list: TS aliases must be preserved, because the
    // locally-bound name is what a call expression uses.
    const tree = await parse(`import { eq as equal, and } from "drizzle-orm";`);
    const imports = extractor.extractImports(tree.rootNode);
    expect(imports[0]?.names).toEqual(["equal", "and"]);
  });

  it("captures default imports", async () => {
    const tree = await parse(`import React from "react";`);
    const imports = extractor.extractImports(tree.rootNode);
    expect(imports).toEqual([{ module: "react", names: ["React"] }]);
  });

  it("captures namespace imports", async () => {
    const tree = await parse(`import * as z from "zod";`);
    const imports = extractor.extractImports(tree.rootNode);
    expect(imports[0]?.names).toEqual(["z"]);
  });

  it("captures side-effect imports with no names", async () => {
    const tree = await parse(`import "./polyfill";`);
    const imports = extractor.extractImports(tree.rootNode);
    expect(imports).toEqual([{ module: "./polyfill", names: [] }]);
  });
});

describe("TypeScriptExtractor.parseParentClassSignature", () => {
  it("extracts the extends target", () => {
    expect(extractor.parseParentClassSignature("class Foo extends Bar")).toBe("Bar");
  });
  it("ignores implements", () => {
    expect(
      extractor.parseParentClassSignature("class Foo extends Bar implements Qux"),
    ).toBe("Bar");
  });
  it("strips generic parameters", () => {
    expect(extractor.parseParentClassSignature("class Foo extends Bar<string>")).toBe("Bar");
  });
  it("returns null for classes without an extends clause", () => {
    expect(extractor.parseParentClassSignature("class Foo")).toBeNull();
    expect(extractor.parseParentClassSignature("class Foo implements X")).toBeNull();
  });
});

describe("TypeScriptExtractor.resolveImport", () => {
  const files = new Set([
    "packages/a/src/index.ts",
    "packages/a/src/utils.ts",
    "packages/a/src/helpers/index.ts",
    "packages/b/src/index.tsx",
  ]);

  it("returns null for non-relative imports", () => {
    expect(
      extractor.resolveImport("drizzle-orm", files, "packages/a/src/index.ts"),
    ).toBeNull();
    expect(extractor.resolveImport("react", files, "packages/a/src/index.ts")).toBeNull();
  });

  it("resolves a sibling .ts file", () => {
    expect(
      extractor.resolveImport("./utils", files, "packages/a/src/index.ts"),
    ).toBe("packages/a/src/utils.ts");
  });

  it("resolves a folder import via /index.ts", () => {
    expect(
      extractor.resolveImport("./helpers", files, "packages/a/src/index.ts"),
    ).toBe("packages/a/src/helpers/index.ts");
  });

  it("resolves .tsx when no .ts exists", () => {
    expect(extractor.resolveImport("./index", files, "packages/b/src/foo.ts")).toBe(
      "packages/b/src/index.tsx",
    );
  });

  it("returns null when no candidate matches", () => {
    expect(
      extractor.resolveImport("./does-not-exist", files, "packages/a/src/index.ts"),
    ).toBeNull();
  });
});

describe("TypeScriptExtractor — call extraction + enclosing symbol", () => {
  it("binds each call to the method that contains it", async () => {
    const tree = await parse(`
export class A {
  first() {
    helper();
  }
  second() {
    other();
  }
}
`);
    const syms = extractor.extractSymbols(tree.rootNode);
    const calls = extractor.extractCalls(tree.rootNode, syms);
    const firstCall = calls.find((c) => c.toName === "helper");
    const secondCall = calls.find((c) => c.toName === "other");
    expect(firstCall?.fromSymbolName).toBe("first");
    expect(secondCall?.fromSymbolName).toBe("second");
  });
});
