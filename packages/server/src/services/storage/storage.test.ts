// Unit tests for the pluggable storage layer (spec-300 t-2). DB-FREE by design
// so they never race the integration suites: everything here is filesystem +
// crypto only.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  getStorageProvider,
  LocalStorageProvider,
  signStorageToken,
  StorageTokenError,
  verifyStorageToken,
} from "./index.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-300";
const SECRET = "unit-test-storage-signing-secret-0123456789";

describe("storage — local driver", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "memex-storage-test-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("round-trips bytes: write then read the same bytes back", async () => {
    // ac-14: binary asset bytes land in blob storage (here, the filesystem
    // backend), not Postgres.
    tagAc(`${SPEC}/acs/ac-14`);
    tagAc(`${SPEC}/acs/ac-40`);
    const provider = new LocalStorageProvider({ baseDir, secret: SECRET });

    const key = "memex-abc/skill-1/logo.png";
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 255, 42]);
    await provider.putObject(key, bytes);

    const readBack = await provider.getObject(key);
    expect(new Uint8Array(readBack)).toEqual(bytes);
  });

  it("delete removes an object (and is idempotent)", async () => {
    tagAc(`${SPEC}/acs/ac-40`);
    const provider = new LocalStorageProvider({ baseDir, secret: SECRET });
    const key = "memex-abc/skill-1/doomed.bin";

    await provider.putObject(key, new Uint8Array([1, 2, 3]));
    await expect(provider.getObject(key)).resolves.toBeInstanceOf(Buffer);

    await provider.delete(key);
    await expect(provider.getObject(key)).rejects.toThrow();
    // Deleting a missing key is not an error.
    await expect(provider.delete(key)).resolves.toBeUndefined();
  });

  it("mints app-relative signed read/upload URLs carrying a token", async () => {
    // ac-16: aux bytes are delivered only via a short-lived signed URL — the
    // driver never returns a public/permanent URL.
    tagAc(`${SPEC}/acs/ac-16`);
    const provider = new LocalStorageProvider({ baseDir, secret: SECRET });

    const readUrl = await provider.getSignedReadUrl("memex-abc/skill-1/logo.png");
    expect(readUrl).toContain("/api/storage/local/read?token=");

    const upload = await provider.getUploadUrl("memex-abc/skill-1/logo.png", "image/png");
    expect(upload.method).toBe("PUT");
    expect(upload.url).toContain("/api/storage/local/upload?token=");
    expect(upload.headers["content-type"]).toBe("image/png");
  });
});

describe("storage — signed token TTL", () => {
  it("a minted read URL carries an expiry and is refused after its TTL", () => {
    // ac-16 + ac-40: the read credential is short-lived; verification rejects it
    // once the expiry has passed.
    tagAc(`${SPEC}/acs/ac-16`);
    tagAc(`${SPEC}/acs/ac-40`);

    const now = 1_000_000; // fixed clock (seconds)
    const ttl = 15 * 60;
    const token = signStorageToken(
      { key: "memex-abc/skill-1/logo.png", op: "read", exp: now + ttl },
      SECRET,
    );

    // Valid one second before expiry.
    const payload = verifyStorageToken(token, SECRET, now + ttl - 1);
    expect(payload.op).toBe("read");
    expect(payload.exp).toBe(now + ttl);

    // Expired at/after the TTL boundary.
    expect(() => verifyStorageToken(token, SECRET, now + ttl)).toThrow(StorageTokenError);
    expect(() => verifyStorageToken(token, SECRET, now + ttl + 60)).toThrow(/expired/i);
  });

  it("rejects a tampered token", () => {
    tagAc(`${SPEC}/acs/ac-40`);
    const now = 1_000_000;
    const token = signStorageToken(
      { key: "k", op: "read", exp: now + 900 },
      SECRET,
    );
    const tampered = `${token}x`;
    expect(() => verifyStorageToken(tampered, SECRET, now)).toThrow(StorageTokenError);
    // Wrong secret is also refused.
    expect(() => verifyStorageToken(token, "another-secret-that-is-long-enough-xx", now)).toThrow(
      StorageTokenError,
    );
  });
});

describe("storage — factory selects driver by env", () => {
  const saved = { ...process.env };

  afterEach(() => {
    // Restore the global env stub so we don't leak into sibling suites.
    process.env = { ...saved };
  });

  it("returns the driver named by STORAGE_PROVIDER with no code change", () => {
    // ac-17: a self-host operator points storage at their own backend via
    // config alone — flip the env, get a different driver.
    tagAc(`${SPEC}/acs/ac-17`);
    tagAc(`${SPEC}/acs/ac-40`);

    process.env.STORAGE_PROVIDER = "local";
    process.env.STORAGE_SIGNING_SECRET = SECRET;
    expect(getStorageProvider().kind).toBe("local");

    process.env.STORAGE_PROVIDER = "gcs";
    process.env.STORAGE_GCS_BUCKET = "memex-aux-test";
    // Constructing the gcs driver must NOT load @google-cloud/storage (lazy).
    expect(getStorageProvider().kind).toBe("gcs");
  });

  it("throws a clear error for the reserved s3 slot", () => {
    tagAc(`${SPEC}/acs/ac-17`);
    process.env.STORAGE_PROVIDER = "s3";
    expect(() => getStorageProvider()).toThrow(/not yet implemented/i);
  });

  it("errors when gcs is selected without a bucket", () => {
    tagAc(`${SPEC}/acs/ac-17`);
    process.env.STORAGE_PROVIDER = "gcs";
    delete process.env.STORAGE_GCS_BUCKET;
    expect(() => getStorageProvider()).toThrow(/STORAGE_GCS_BUCKET/);
  });
});
