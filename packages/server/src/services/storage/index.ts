// Storage factory — pick the auxiliary-file byte backend by env, not code (dec-19).
//
// A self-hosting operator points storage at their own backend via configuration
// ALONE (ac-17): set STORAGE_PROVIDER (+ that driver's env) and restart. No fork,
// no code edit. The interface is v1; `s3` is a documented drop-in slot.
//
// AUTHORIZATION lives in the CALLER, not here (see provider.ts). The factory
// just hands back the driver named by env.

import { GcsStorageProvider } from "./gcs.js";
import { LocalStorageProvider, resolveLocalSigningSecret } from "./local.js";
import type { StorageProvider } from "./provider.js";

export type {
  StorageProvider,
  StorageProviderKind,
  UploadTarget,
} from "./provider.js";
export { DEFAULT_URL_TTL_SECONDS } from "./provider.js";
export { LocalStorageProvider, resolveLocalSigningSecret } from "./local.js";
export { GcsStorageProvider } from "./gcs.js";
export {
  signStorageToken,
  verifyStorageToken,
  StorageTokenError,
} from "./signed-token.js";
export type { StorageTokenPayload, StorageOp } from "./signed-token.js";

// Default when STORAGE_PROVIDER is unset: local in dev, gcs in prod.
function defaultKind(): string {
  return process.env.NODE_ENV === "production" ? "gcs" : "local";
}

function buildLocal(): StorageProvider {
  return new LocalStorageProvider({
    baseDir: process.env.STORAGE_LOCAL_DIR ?? `${process.cwd()}/.storage`,
    secret: resolveLocalSigningSecret(),
    urlBase: process.env.STORAGE_LOCAL_URL_BASE,
  });
}

function buildGcs(): StorageProvider {
  const bucket = process.env.STORAGE_GCS_BUCKET;
  if (!bucket) {
    throw new Error("STORAGE_PROVIDER=gcs requires STORAGE_GCS_BUCKET to be set.");
  }
  return new GcsStorageProvider({ bucket });
}

/**
 * Construct the storage provider named by `STORAGE_PROVIDER`
 * (`local` | `gcs` | `s3`). Not memoized: the selecting env is the single
 * source of truth, so a process that changes it gets the new driver.
 */
export function getStorageProvider(): StorageProvider {
  const kind = (process.env.STORAGE_PROVIDER ?? defaultKind()).toLowerCase();
  switch (kind) {
    case "local":
      return buildLocal();
    case "gcs":
      return buildGcs();
    case "s3":
      // Interface is v1; the s3 driver is a documented drop-in. Implement
      // S3StorageProvider (AWS SDK v3 presigned URLs) and add a case here.
      throw new Error("STORAGE_PROVIDER=s3 is not yet implemented (drop-in slot reserved).");
    default:
      throw new Error(
        `Unknown STORAGE_PROVIDER='${kind}'. Supported: local, gcs, s3 (s3 not yet implemented).`,
      );
  }
}
