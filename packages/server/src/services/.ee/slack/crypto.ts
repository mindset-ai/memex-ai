// Envelope encryption for user Slack OAuth tokens (doc-23 D-2).
//
// Production path:
//   1. Generate a per-row 256-bit Data Encryption Key (DEK)
//   2. AES-256-GCM the token with the DEK + a fresh 12-byte IV
//   3. Call GCP KMS Encrypt to wrap the DEK with the master CryptoKey
//   4. Store (ciphertext+authTag, iv, wrappedDek) on the user_slack_tokens row
//   5. Discard the DEK immediately
//
// On read: KMS Decrypt the wrappedDek → use the recovered DEK for AES-GCM → discard.
//
// Local-dev plaintext path (NODE_ENV !== 'production' AND SLACK_TOKEN_ENCRYPTION='plaintext'):
// writes the raw token bytes to `ciphertext`, leaves `iv` and `wrappedDek` empty. Lets
// developers run the Slack flow without GCP credentials.
//
// Production-with-plaintext is rejected at module load — the dev flag cannot escape
// into a real environment.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { KeyManagementServiceClient } from "@google-cloud/kms";

const IS_PROD = process.env.NODE_ENV === "production";
const PLAINTEXT_MODE = process.env.SLACK_TOKEN_ENCRYPTION === "plaintext";

if (IS_PROD && PLAINTEXT_MODE) {
  throw new Error(
    "SLACK_TOKEN_ENCRYPTION=plaintext is forbidden when NODE_ENV=production. " +
      "Unset SLACK_TOKEN_ENCRYPTION in production environments — refusing to write " +
      "unencrypted Slack tokens to a production database.",
  );
}

// The KMS CryptoKey path is instance config and must come from the environment —
// there is no baked-in default. A hardcoded key would both ship one deployment's
// resource path in open-core source and create a cross-environment footgun (a prod
// server silently wrapping tokens under another env's key if the var were ever
// unset). deploy.sh always passes KMS_KEY_NAME; local dev sets it explicitly or
// uses the plaintext path. The plaintext path is the only case that skips KMS.
const KMS_KEY_NAME = process.env.KMS_KEY_NAME;
const USING_KMS = IS_PROD || !PLAINTEXT_MODE;
if (USING_KMS && !KMS_KEY_NAME) {
  throw new Error(
    "KMS_KEY_NAME is required to encrypt/decrypt Slack tokens. Set it to your KMS " +
      "CryptoKey resource path (projects/<project>/locations/<loc>/keyRings/<ring>/" +
      "cryptoKeys/<key>). For local development only, set SLACK_TOKEN_ENCRYPTION=plaintext " +
      "with NODE_ENV!=production instead.",
  );
}

// Module-init credentials probe. In production we ask Application Default Credentials
// to resolve a project ID — this fails fast with a clear error message at server boot
// if GOOGLE_APPLICATION_CREDENTIALS is missing, the metadata service is unreachable
// (off Cloud Run), or the SA has no resourcemanager.projects.get binding. We deliberately
// do NOT call getCryptoKey() here — that requires `cloudkms.cryptoKeys.get` which is not
// granted by `cryptoKeyEncrypterDecrypter`. A misconfigured KMS_KEY_NAME surfaces at first
// encrypt with a clear `permission_denied` / `not_found` error.
let kmsClient: KeyManagementServiceClient | null = null;
if (IS_PROD && !PLAINTEXT_MODE) {
  const client = new KeyManagementServiceClient();
  await client.getProjectId();
  kmsClient = client;
}

function getKmsClient(): KeyManagementServiceClient {
  if (!kmsClient) kmsClient = new KeyManagementServiceClient();
  return kmsClient;
}

export interface EncryptedToken {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  wrappedDek: Uint8Array;
}

const EMPTY = new Uint8Array(0);
const AES_GCM_IV_LENGTH = 12;
const AES_GCM_TAG_LENGTH = 16;
const DEK_BYTES = 32;

export async function encryptToken(raw: string): Promise<EncryptedToken> {
  if (!IS_PROD && PLAINTEXT_MODE) {
    return {
      ciphertext: new TextEncoder().encode(raw),
      iv: EMPTY,
      wrappedDek: EMPTY,
    };
  }

  const dek = randomBytes(DEK_BYTES);
  const iv = randomBytes(AES_GCM_IV_LENGTH);

  const cipher = createCipheriv("aes-256-gcm", dek, iv);
  const ciphertext = Buffer.concat([
    cipher.update(raw, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const [response] = await getKmsClient().encrypt({
    name: KMS_KEY_NAME,
    plaintext: dek,
  });

  // Discard the DEK. V8 GC happens eventually; explicit overwrite is hygiene against
  // process-memory inspection between GC cycles.
  dek.fill(0);

  if (!response.ciphertext) {
    throw new Error("KMS encrypt returned empty ciphertext");
  }

  const wrappedDek =
    response.ciphertext instanceof Uint8Array
      ? response.ciphertext
      : Buffer.from(response.ciphertext);

  return {
    ciphertext: new Uint8Array(ciphertext),
    iv: new Uint8Array(iv),
    wrappedDek: new Uint8Array(wrappedDek),
  };
}

export async function decryptToken(encrypted: EncryptedToken): Promise<string> {
  if (!IS_PROD && PLAINTEXT_MODE) {
    return new TextDecoder().decode(encrypted.ciphertext);
  }

  const [response] = await getKmsClient().decrypt({
    name: KMS_KEY_NAME,
    ciphertext: Buffer.from(encrypted.wrappedDek),
  });

  if (!response.plaintext) {
    throw new Error("KMS decrypt returned empty plaintext");
  }

  const dek = Buffer.from(response.plaintext);
  const ciphertext = Buffer.from(encrypted.ciphertext);

  if (ciphertext.length < AES_GCM_TAG_LENGTH) {
    throw new Error("Ciphertext too short to contain AES-GCM auth tag");
  }
  const tag = ciphertext.subarray(ciphertext.length - AES_GCM_TAG_LENGTH);
  const body = ciphertext.subarray(0, ciphertext.length - AES_GCM_TAG_LENGTH);

  const decipher = createDecipheriv("aes-256-gcm", dek, Buffer.from(encrypted.iv));
  decipher.setAuthTag(tag);

  try {
    const plaintext = Buffer.concat([decipher.update(body), decipher.final()]);
    return plaintext.toString("utf8");
  } finally {
    dek.fill(0);
  }
}
