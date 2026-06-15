#!/usr/bin/env node
// CI publish entrypoint for @mindset-ai/db-schema. Assumes the dist is already
// built. Computes the schema content hash, asks the registry what's published,
// and publishes a NEW pinnable version only when the schema actually changed —
// the no-op guard. Auth comes from NODE_AUTH_TOKEN (the workflow wires it to
// the built-in GITHUB_TOKEN). spec-279 ac-2/ac-8/ac-9.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { computeSchemaHash, decidePublish, bumpPatch } from "./publish-guard.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, "..");
const schemaPath = join(pkgDir, "..", "server", "src", "db", "schema.ts");
const manifestPath = join(pkgDir, "package.json");

const currentHash = computeSchemaHash(readFileSync(schemaPath, "utf8"));

// What's published now? `schemaHash` is a custom field we stamp on each publish.
function viewPublished() {
  try {
    const out = execFileSync("npm", ["view", "@mindset-ai/db-schema", "--json"], { encoding: "utf8" });
    return JSON.parse(out);
  } catch {
    return null; // never published
  }
}
const published = viewPublished();
const decision = decidePublish({ publishedHash: published?.schemaHash ?? null, currentHash });
console.log(decision.reason);
if (!decision.publish) process.exit(0); // unchanged schema → no new version

// Stamp the new pinnable version + the schema hash that justifies it.
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.version = published?.version ? bumpPatch(published.version) : manifest.version;
manifest.schemaHash = currentHash;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`publishing @mindset-ai/db-schema@${manifest.version} (schemaHash ${currentHash})`);

const args = process.env.DRY_RUN === "1" ? ["publish", "--dry-run"] : ["publish"];
execFileSync("npm", args, { cwd: pkgDir, stdio: "inherit" });
