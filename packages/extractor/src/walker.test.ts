import { describe, expect, it } from "vitest";
import { commonBasePath, detectLanguage, fileHash, isTestFile } from "./walker.ts";

describe("detectLanguage", () => {
  it("maps .py to python", () => {
    expect(detectLanguage("src/foo.py")).toBe("python");
  });
  it("maps .ts and .tsx to typescript", () => {
    expect(detectLanguage("src/foo.ts")).toBe("typescript");
    expect(detectLanguage("src/Foo.tsx")).toBe("typescript");
  });
  it("maps .js and .jsx to javascript", () => {
    expect(detectLanguage("src/foo.js")).toBe("javascript");
    expect(detectLanguage("src/foo.jsx")).toBe("javascript");
  });
  it("returns null for unknown extensions", () => {
    expect(detectLanguage("README.md")).toBeNull();
    expect(detectLanguage("noext")).toBeNull();
  });
  it("is case-insensitive", () => {
    expect(detectLanguage("Foo.PY")).toBe("python");
    expect(detectLanguage("Foo.TS")).toBe("typescript");
  });
});

describe("fileHash", () => {
  it("is deterministic", () => {
    expect(fileHash("hello")).toBe(fileHash("hello"));
  });
  it("differs for different content", () => {
    expect(fileHash("hello")).not.toBe(fileHash("world"));
  });
  it("produces a 16-char hex prefix of sha256", () => {
    const h = fileHash("some content");
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });
  it("handles empty content", () => {
    expect(fileHash("")).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("isTestFile", () => {
  it("identifies files under test/ or tests/", () => {
    expect(isTestFile("src/tests/foo.py", "")).toBe(true);
    expect(isTestFile("project/test/helpers.ts", "")).toBe(true);
  });
  it("identifies __tests__/ and spec/ folders", () => {
    expect(isTestFile("src/__tests__/foo.ts", "")).toBe(true);
    expect(isTestFile("spec/thing.ts", "")).toBe(true);
  });
  it("identifies Python test file name conventions", () => {
    expect(isTestFile("test_foo.py", "")).toBe(true);
    expect(isTestFile("foo_test.py", "")).toBe(true);
  });
  it("identifies Python test files by import in the header", () => {
    // Not in test/ folder, no test_/ prefix, but imports pytest → test.
    expect(isTestFile("utils.py", "import pytest\n\ndef test_x(): ...")).toBe(true);
  });
  it("does not flag normal files as tests", () => {
    expect(isTestFile("src/service.py", "def do_thing(): pass")).toBe(false);
    expect(isTestFile("src/main.ts", "export function main() {}")).toBe(false);
  });
});

describe("commonBasePath", () => {
  it("returns the single path when only one given", () => {
    expect(commonBasePath(["/a/b/c"])).toBe("/a/b/c");
  });
  it("returns the shared prefix of multiple paths", () => {
    expect(commonBasePath(["/a/b/c", "/a/b/d"])).toBe("/a/b");
    expect(commonBasePath(["/a/b/c/x", "/a/b/c/y/z"])).toBe("/a/b/c");
  });
  it("returns '/' when no path prefix is shared", () => {
    expect(commonBasePath(["/a/x", "/b/y"])).toBe("/");
  });
});
