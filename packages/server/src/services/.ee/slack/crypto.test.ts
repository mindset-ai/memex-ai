import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the KMS client. The mocked encrypt/decrypt is a trivial "wrap" — XOR by 0xAA —
// so the test can detect that:
//   (a) the DEK was sent to KMS for wrapping (assertions on the mock)
//   (b) decrypt recovers the original DEK bytes (round-trip works)
// We assert call counts to verify DEK is not retained across encrypt operations: every
// encrypt produces a unique KMS.encrypt call.
const kmsEncrypt = vi.fn();
const kmsDecrypt = vi.fn();
const kmsGetProjectId = vi.fn();

vi.mock("@google-cloud/kms", () => {
  // Class-based mock so `new KeyManagementServiceClient()` works. vi.fn() with an
  // arrow-function `mockImplementation` is not constructible.
  return {
    KeyManagementServiceClient: class {
      encrypt = kmsEncrypt;
      decrypt = kmsDecrypt;
      getProjectId = kmsGetProjectId;
    },
  };
});

function xorWrap(bytes: Uint8Array): Uint8Array {
  return bytes.map((b) => b ^ 0xaa);
}

beforeEach(() => {
  kmsEncrypt.mockReset();
  kmsDecrypt.mockReset();
  kmsGetProjectId.mockReset();
  // Default behaviour: wrap = XOR 0xAA, unwrap = XOR 0xAA again.
  kmsEncrypt.mockImplementation(async ({ plaintext }: { plaintext: Buffer }) => {
    return [{ ciphertext: xorWrap(plaintext) }];
  });
  kmsDecrypt.mockImplementation(async ({ ciphertext }: { ciphertext: Buffer }) => {
    return [{ plaintext: xorWrap(ciphertext) }];
  });
  kmsGetProjectId.mockResolvedValue("test-project");
  // KMS_KEY_NAME has no hardcoded default — the KMS path requires it. Provide a
  // dummy resource path for the tests that exercise the KMS path (the mock ignores
  // the value); the plaintext-path tests don't read it.
  vi.stubEnv("KMS_KEY_NAME", "projects/test-project/locations/us-test/keyRings/memex/cryptoKeys/test-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

// ──────────────────────────────────────────────────────────────────────────
// Module-init guards
// ──────────────────────────────────────────────────────────────────────────

describe("module-init guards", () => {
  it("throws at module load when NODE_ENV=production and SLACK_TOKEN_ENCRYPTION=plaintext", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SLACK_TOKEN_ENCRYPTION", "plaintext");

    await expect(import(`./crypto.js`)).rejects.toThrow(
      /SLACK_TOKEN_ENCRYPTION=plaintext is forbidden when NODE_ENV=production/,
    );
  });

  it("throws at module load when KMS_KEY_NAME is unset on the KMS path (no hardcoded default)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("SLACK_TOKEN_ENCRYPTION", "");
    vi.stubEnv("KMS_KEY_NAME", "");

    await expect(import(`./crypto.js`)).rejects.toThrow(/KMS_KEY_NAME is required/);
  });

  it("probes KMS credentials at module load when NODE_ENV=production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SLACK_TOKEN_ENCRYPTION", "");

    await import(`./crypto.js`);

    expect(kmsGetProjectId).toHaveBeenCalledTimes(1);
  });

  it("surfaces credential failure at module load (not at first use) in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SLACK_TOKEN_ENCRYPTION", "");
    kmsGetProjectId.mockRejectedValueOnce(new Error("Could not load the default credentials"));

    await expect(import(`./crypto.js`)).rejects.toThrow(
      /Could not load the default credentials/,
    );
  });

  it("does not probe KMS at module load when NODE_ENV is not production", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("SLACK_TOKEN_ENCRYPTION", "");

    await import(`./crypto.js`);

    expect(kmsGetProjectId).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Encrypt / decrypt round-trip (KMS path)
// ──────────────────────────────────────────────────────────────────────────

describe("encrypt/decrypt round-trip (KMS path)", () => {
  it("round-trips a short token", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("SLACK_TOKEN_ENCRYPTION", "");
    const { encryptToken, decryptToken } = await import(`./crypto.js`);

    const raw = "xoxp-1234567890-ABCDEFGHIJK";
    const encrypted = await encryptToken(raw);

    expect(encrypted.ciphertext.length).toBeGreaterThan(0);
    expect(encrypted.iv.length).toBe(12);
    expect(encrypted.wrappedDek.length).toBe(32);

    const recovered = await decryptToken(encrypted);
    expect(recovered).toBe(raw);
  });

  it("round-trips a 4 KB token", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("SLACK_TOKEN_ENCRYPTION", "");
    const { encryptToken, decryptToken } = await import(`./crypto.js`);

    const raw = "x".repeat(4096);
    const encrypted = await encryptToken(raw);
    const recovered = await decryptToken(encrypted);
    expect(recovered).toBe(raw);
  });

  it("produces fresh ciphertext + IV + wrappedDek on each call (per-row DEK)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("SLACK_TOKEN_ENCRYPTION", "");
    const { encryptToken } = await import(`./crypto.js`);

    const a = await encryptToken("same-input");
    const b = await encryptToken("same-input");

    expect(Buffer.from(a.ciphertext).equals(Buffer.from(b.ciphertext))).toBe(false);
    expect(Buffer.from(a.iv).equals(Buffer.from(b.iv))).toBe(false);
    expect(Buffer.from(a.wrappedDek).equals(Buffer.from(b.wrappedDek))).toBe(false);
  });

  it("calls KMS.encrypt once per encryptToken and KMS.decrypt once per decryptToken (no DEK caching)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("SLACK_TOKEN_ENCRYPTION", "");
    const { encryptToken, decryptToken } = await import(`./crypto.js`);

    const e1 = await encryptToken("token-1");
    const e2 = await encryptToken("token-2");
    await decryptToken(e1);
    await decryptToken(e2);

    expect(kmsEncrypt).toHaveBeenCalledTimes(2);
    expect(kmsDecrypt).toHaveBeenCalledTimes(2);
  });

  it("rejects ciphertext tampering via AES-GCM auth tag verification", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("SLACK_TOKEN_ENCRYPTION", "");
    const { encryptToken, decryptToken } = await import(`./crypto.js`);

    const encrypted = await encryptToken("authentic");
    const tampered = {
      ...encrypted,
      ciphertext: new Uint8Array(encrypted.ciphertext),
    };
    tampered.ciphertext[0] ^= 0x01;

    await expect(decryptToken(tampered)).rejects.toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Plaintext-dev path
// ──────────────────────────────────────────────────────────────────────────

describe("plaintext-dev path (NODE_ENV !== production + SLACK_TOKEN_ENCRYPTION=plaintext)", () => {
  it("stores the raw token in ciphertext with empty iv + wrappedDek", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("SLACK_TOKEN_ENCRYPTION", "plaintext");
    const { encryptToken } = await import(`./crypto.js`);

    const raw = "xoxp-plaintext-token-value";
    const encrypted = await encryptToken(raw);

    expect(new TextDecoder().decode(encrypted.ciphertext)).toBe(raw);
    expect(encrypted.iv.length).toBe(0);
    expect(encrypted.wrappedDek.length).toBe(0);
  });

  it("does not call KMS in plaintext mode", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("SLACK_TOKEN_ENCRYPTION", "plaintext");
    const { encryptToken, decryptToken } = await import(`./crypto.js`);

    const encrypted = await encryptToken("test-token");
    await decryptToken(encrypted);

    expect(kmsEncrypt).not.toHaveBeenCalled();
    expect(kmsDecrypt).not.toHaveBeenCalled();
  });

  it("round-trips through encrypt → decrypt", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("SLACK_TOKEN_ENCRYPTION", "plaintext");
    const { encryptToken, decryptToken } = await import(`./crypto.js`);

    const raw = "xoxp-roundtrip-test";
    expect(await decryptToken(await encryptToken(raw))).toBe(raw);
  });
});
