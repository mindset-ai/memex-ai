// spec-300 t-10 — server-side byte persistence for a Skill's BINARY auxiliary
// files, layered ON TOP of the t-2 StorageProvider (dec-19). We do NOT modify the
// provider internals; we consume its exports.
//
// The StorageProvider interface is designed for CLIENT-direct transfer (mint a
// signed URL, the browser PUTs/GETs the bytes). `createSkill`, however, receives
// small binary bytes INLINE on the server, so it needs a server-side write. The
// two shipped drivers differ in how that write happens:
//
//   * local (dev + simple self-host, and every test) exposes an off-interface
//     `putObject(key, bytes)` — we call it directly.
//   * gcs (prod) has no server-side put on the interface, but its signed upload
//     URL is an ABSOLUTE, internet-reachable URL — we mint one and PUT to it.
//
// Reads always go through the provider's signed-read URL (ac-16: bytes are only
// ever delivered via a short-lived signed URL, never a public object).
//
// AUTHORIZATION is the CALLER's job (dec-19): the skills service resolves the
// Memex + membership BEFORE it ever asks us to move bytes. This module is pure
// byte plumbing over an already-authorized key.

import { createHash } from "node:crypto";
import {
  LocalStorageProvider,
  type StorageProvider,
} from "../storage/index.js";

/** The opaque object key for one Skill auxiliary file. Caller-owned + already
 *  authorized. Namespaced by the Skill's doc id so keys never collide across
 *  Skills and a Skill's blobs are easy to enumerate/clean up. */
export function skillBlobKey(skillDocId: string, path: string): string {
  return `skills/${skillDocId}/${path}`;
}

/** sha256 hex of the bytes — the content-addressing anchor stored on the manifest
 *  row (`skill_files.checksum`), forward-compat with document versioning
 *  (spec-448). Accepts text or binary. */
export function checksumOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Persist `bytes` for `key` through the storage provider, server-side.
 * Idempotent per key (a re-put overwrites). Throws a descriptive error on
 * failure so the caller can surface it (the write path never swallows a storage
 * fault silently).
 */
export async function putSkillBlob(
  provider: StorageProvider,
  key: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<void> {
  try {
    // local: the off-interface server-side byte op. This is the dev/test path.
    if (provider instanceof LocalStorageProvider) {
      await provider.putObject(key, bytes);
      return;
    }
    // Cloud drivers (gcs, future s3): mint a signed upload URL and PUT to it. The
    // URL is absolute + internet-reachable, so a server-side fetch works exactly
    // like the browser-direct upload the interface was designed for.
    const target = await provider.getUploadUrl(key, contentType);
    // Wrap the bytes in a Blob — an unambiguous BodyInit across the DOM/undici
    // fetch typings (a bare Uint8Array is not accepted by every overload).
    const res = await fetch(target.url, {
      method: target.method,
      headers: target.headers,
      body: new Blob([new Uint8Array(bytes)], { type: contentType }),
    });
    if (!res.ok) {
      throw new Error(`upload PUT returned ${res.status} ${res.statusText}`);
    }
  } catch (error) {
    throw new Error(
      `Failed to store skill blob '${key}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Delete a Skill blob. Idempotent — a missing key is not an error (mirrors the
 * provider's own delete contract). Best-effort: a failure is surfaced so the
 * caller can log it, but the driver never throws on a missing object.
 */
export async function deleteSkillBlob(
  provider: StorageProvider,
  key: string,
): Promise<void> {
  await provider.delete(key);
}
