// `local` storage driver — filesystem under a configurable base dir.
//
// For dev and simple self-hosting. NO cloud dependency. Signed read/upload URLs
// are app-relative (e.g. `/api/storage/local/read?token=…`) carrying an
// HMAC-signed, expiring token (see signed-token.ts). An app route verifies the
// token, then calls this driver's byte ops (`putObject`/`getObject`) to fulfil
// the transfer. Those byte ops are LOCAL-ONLY (not on the StorageProvider
// interface) because the gcs/s3 drivers hand the client a URL that talks to the
// cloud directly — there is no server hop for their bytes.
//
// Objects live as plain files under `baseDir`; nothing here is ever public.

import { createHmac } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
  DEFAULT_URL_TTL_SECONDS,
  type StorageProvider,
  type StorageProviderKind,
  type UploadTarget,
} from "./provider.js";
import { signStorageToken } from "./signed-token.js";

export interface LocalStorageOptions {
  /** Absolute dir under which object bytes are written. */
  readonly baseDir: string;
  /** Secret used to sign the app-relative URL tokens. */
  readonly secret: string;
  /** URL prefix the app mounts its local-storage route at. */
  readonly urlBase?: string;
  /** URL TTL in seconds. Defaults to ~15 min. */
  readonly ttlSeconds?: number;
}

// Map an opaque object key to a safe on-disk path under baseDir. A key can be
// caller-supplied, so we defend against path traversal: resolve the joined path
// and confirm it stays inside baseDir.
function safePath(baseDir: string, key: string): string {
  const base = resolve(baseDir);
  const full = resolve(join(base, key));
  if (full !== base && !full.startsWith(base + sep)) {
    throw new Error(`Storage key escapes base dir: ${key}`);
  }
  return full;
}

export class LocalStorageProvider implements StorageProvider {
  readonly kind: StorageProviderKind = "local";
  private readonly baseDir: string;
  private readonly secret: string;
  private readonly urlBase: string;
  private readonly ttlSeconds: number;

  constructor(opts: LocalStorageOptions) {
    if (!opts.baseDir) throw new Error("LocalStorageProvider requires a baseDir");
    if (!opts.secret) throw new Error("LocalStorageProvider requires a signing secret");
    this.baseDir = opts.baseDir;
    this.secret = opts.secret;
    this.urlBase = (opts.urlBase ?? "/api/storage/local").replace(/\/$/, "");
    this.ttlSeconds = opts.ttlSeconds ?? DEFAULT_URL_TTL_SECONDS;
  }

  private tokenFor(key: string, op: "read" | "write", contentType?: string): string {
    const exp = Math.floor(Date.now() / 1000) + this.ttlSeconds;
    return signStorageToken({ key, op, exp, contentType }, this.secret);
  }

  async getUploadUrl(key: string, contentType: string): Promise<UploadTarget> {
    if (!key) throw new Error("getUploadUrl requires a key");
    if (!contentType) throw new Error("getUploadUrl requires a contentType");
    const token = this.tokenFor(key, "write", contentType);
    return {
      url: `${this.urlBase}/upload?token=${encodeURIComponent(token)}`,
      method: "PUT",
      headers: { "content-type": contentType },
    };
  }

  async getSignedReadUrl(key: string): Promise<string> {
    if (!key) throw new Error("getSignedReadUrl requires a key");
    const token = this.tokenFor(key, "read");
    return `${this.urlBase}/read?token=${encodeURIComponent(token)}`;
  }

  async delete(key: string): Promise<void> {
    // Idempotent: force ignores a missing file so deleting twice is not an error.
    try {
      await rm(safePath(this.baseDir, key), { force: true });
    } catch (error) {
      throw new Error(
        `Failed to delete storage object '${key}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // --- LOCAL-ONLY byte ops (not on StorageProvider) --------------------------
  // Called by the app's local-storage route AFTER it has verified the signed
  // token. Kept off the interface because cloud drivers never touch bytes here.

  /** Persist bytes for `key`. Creates parent dirs as needed. */
  async putObject(key: string, bytes: Uint8Array): Promise<void> {
    const path = safePath(this.baseDir, key);
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    } catch (error) {
      throw new Error(
        `Failed to write storage object '${key}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Read bytes for `key`. Throws if the object does not exist. */
  async getObject(key: string): Promise<Buffer> {
    const path = safePath(this.baseDir, key);
    try {
      return await readFile(path);
    } catch (error) {
      throw new Error(
        `Failed to read storage object '${key}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * Resolve the local driver's signing secret. Prefers a dedicated
 * STORAGE_SIGNING_SECRET, falls back to AUTH_JWT_SECRET (both are local
 * app secrets, never cloud credentials). In production one of them MUST be set
 * (>=32 chars); dev gets a stable fallback so restarts don't invalidate URLs.
 */
export function resolveLocalSigningSecret(): string {
  const explicit = process.env.STORAGE_SIGNING_SECRET ?? process.env.AUTH_JWT_SECRET;
  if (explicit && explicit.length >= 32) return explicit;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "STORAGE_SIGNING_SECRET (or AUTH_JWT_SECRET) is required in production (min 32 chars).",
    );
  }
  // Derive a stable dev secret so local URLs survive a restart.
  return createHmac("sha256", "memex-local-storage-dev")
    .update("signing-secret")
    .digest("hex");
}
