import { createHash } from "node:crypto";

// Pure, unit-testable core of the publish step. Kept free of I/O so the no-op
// guard (ac-9) and the pinnable-version logic (ac-2) can be tested directly,
// without a live registry. spec-279.

/** Stable short content hash of the schema source. */
export function computeSchemaHash(source) {
  return createHash("sha256").update(source, "utf8").digest("hex").slice(0, 12);
}

/**
 * The no-op guard. Publish only when the schema content actually changed since
 * the last published version. `publishedHash` is the `schemaHash` recorded on
 * the latest registry version (null if never published).
 */
export function decidePublish({ publishedHash, currentHash }) {
  if (!currentHash) throw new Error("currentHash is required");
  if (publishedHash && publishedHash === currentHash) {
    return { publish: false, reason: `schema unchanged (hash ${currentHash}) — skipping publish` };
  }
  return {
    publish: true,
    reason: publishedHash
      ? `schema changed (${publishedHash} → ${currentHash}) — publishing`
      : `first publish (hash ${currentHash})`,
  };
}

/** Next pinnable version: bump the patch of a plain x.y.z semver. */
export function bumpPatch(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "");
  if (!m) throw new Error(`not a plain semver: ${version}`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}
