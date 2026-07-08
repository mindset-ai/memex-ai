// `gcs` storage driver — Google Cloud Storage, the prod backend (std-9).
//
// std-24 dependency discipline: `@google-cloud/storage` is a heavy cloud SDK.
// It MUST NOT load unless this driver is actually selected (STORAGE_PROVIDER=gcs).
// We therefore LAZY-import it INSIDE the methods, never at module top-level.
// Constructing a GcsStorageProvider pulls in nothing — the SDK only loads on the
// first call that talks to GCS. This keeps `local` self-hosters (and every test)
// free of the cloud dependency.
//
// URLs are V4 signed URLs. Buckets/objects stay PRIVATE — this driver never
// calls makePublic() / sets a public ACL (ac-16).

import {
  DEFAULT_URL_TTL_SECONDS,
  type StorageProvider,
  type StorageProviderKind,
  type UploadTarget,
} from "./provider.js";

export interface GcsStorageOptions {
  /** Target bucket name (private). */
  readonly bucket: string;
  /** URL TTL in seconds. Defaults to ~15 min. */
  readonly ttlSeconds?: number;
}

export class GcsStorageProvider implements StorageProvider {
  readonly kind: StorageProviderKind = "gcs";
  private readonly bucketName: string;
  private readonly ttlMs: number;

  constructor(opts: GcsStorageOptions) {
    if (!opts.bucket) throw new Error("GcsStorageProvider requires a bucket name");
    this.bucketName = opts.bucket;
    this.ttlMs = (opts.ttlSeconds ?? DEFAULT_URL_TTL_SECONDS) * 1000;
  }

  // Lazily import the SDK and return a File handle for `key`. This is the only
  // place @google-cloud/storage is loaded.
  private async fileFor(key: string) {
    const { Storage } = await import("@google-cloud/storage");
    const storage = new Storage();
    return storage.bucket(this.bucketName).file(key);
  }

  async getUploadUrl(key: string, contentType: string): Promise<UploadTarget> {
    if (!key) throw new Error("getUploadUrl requires a key");
    if (!contentType) throw new Error("getUploadUrl requires a contentType");
    try {
      const file = await this.fileFor(key);
      const [url] = await file.getSignedUrl({
        version: "v4",
        action: "write",
        expires: Date.now() + this.ttlMs,
        contentType,
      });
      return { url, method: "PUT", headers: { "content-type": contentType } };
    } catch (error) {
      throw new Error(
        `Failed to mint GCS upload URL for '${key}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async getSignedReadUrl(key: string): Promise<string> {
    if (!key) throw new Error("getSignedReadUrl requires a key");
    try {
      const file = await this.fileFor(key);
      const [url] = await file.getSignedUrl({
        version: "v4",
        action: "read",
        expires: Date.now() + this.ttlMs,
      });
      return url;
    } catch (error) {
      throw new Error(
        `Failed to mint GCS read URL for '${key}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async delete(key: string): Promise<void> {
    try {
      const file = await this.fileFor(key);
      // ignoreNotFound keeps delete idempotent (matches the local driver).
      await file.delete({ ignoreNotFound: true });
    } catch (error) {
      throw new Error(
        `Failed to delete GCS object '${key}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
