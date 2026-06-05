import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tagAc } from "./index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AC = "mindset-prod/memex-building-itself/specs/spec-115/acs";

describe("package metadata", () => {
  it("package.json declares zero runtime dependencies (ac-23)", () => {
    tagAc(`${AC}/ac-23`);
    const pkg = JSON.parse(
      readFileSync(join(__dirname, "..", "package.json"), "utf-8"),
    );
    const deps = pkg.dependencies ?? {};
    expect(Object.keys(deps).length).toBe(0);
  });

  it("package.json declares vitest as a peer dependency (ac-23)", () => {
    tagAc(`${AC}/ac-23`);
    const pkg = JSON.parse(
      readFileSync(join(__dirname, "..", "package.json"), "utf-8"),
    );
    expect(pkg.peerDependencies?.vitest).toBeDefined();
  });
});

describe("source structure", () => {
  it("metadata.ts sources its values from process.env reads (ac-22)", () => {
    tagAc(`${AC}/ac-22`);
    const src = readFileSync(join(__dirname, "metadata.ts"), "utf-8");
    expect(src).toMatch(/process\.env/);
  });

  it("README documents the size limits (4KB total, 32 keys, 256 chars) (ac-11)", () => {
    tagAc(`${AC}/ac-11`);
    const readme = readFileSync(
      join(__dirname, "..", "README.md"),
      "utf-8",
    );
    expect(readme).toMatch(/4KB/);
    expect(readme).toMatch(/32 keys/);
    expect(readme).toMatch(/256 chars/);
  });

  it("README lists actor as a top-level wire-format field, not a metadata key [spec-115 dec-6 ac-31]", () => {
    tagAc(`${AC}/ac-31`);
    const readme = readFileSync(
      join(__dirname, "..", "README.md"),
      "utf-8",
    );
    // ac-31: actor moved out of the well-known metadata keys list and into
    // its own top-level section. Find the dedicated `actor` heading and
    // confirm the metadata section does NOT list actor as a well-known key.
    expect(readme).toMatch(/### `actor` — top-level/);
    // The metadata well-known list (now five keys) should NOT include
    // actor as a bullet line.
    const metadataSection = readme.match(
      /### `metadata`[\s\S]*?(?=### |$)/,
    )?.[0] ?? "";
    expect(metadataSection).not.toMatch(/^- `actor`/m);
  });
});
