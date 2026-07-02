// HMAC-signed, expiring token for the `local` storage driver's app-relative
// signed URLs. The local driver has NO cloud dependency, so it can't lean on a
// cloud provider's V4 signing — instead it mints its own bearer token that an
// app route verifies before it serves/accepts bytes.
//
// Format: base64url(json-payload).base64url(hmac-sha256). Same shape idea as
// our hand-rolled JWT (services/auth-jwt.ts) but scoped to a single object key
// + operation + expiry, so a leaked token can only touch one key for a few
// minutes and only in the direction it was minted for.

import { createHmac, timingSafeEqual } from "node:crypto";

export type StorageOp = "read" | "write";

export interface StorageTokenPayload {
  /** Object key this token authorizes. */
  readonly key: string;
  /** Direction: a read token can't be replayed to upload, and vice versa. */
  readonly op: StorageOp;
  /** Expiry, seconds since epoch. */
  readonly exp: number;
  /** For write tokens: the content-type the upload must carry. */
  readonly contentType?: string;
}

/** Thrown when a token is malformed, tampered with, or expired. */
export class StorageTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageTokenError";
  }
}

function base64urlEncode(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf) : buf;
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 2 ? "==" : s.length % 4 === 3 ? "=" : "";
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

/**
 * Sign a storage token. `secret` is the local signing secret (never a cloud
 * credential) — the caller resolves it from env once and passes it in.
 */
export function signStorageToken(payload: StorageTokenPayload, secret: string): string {
  if (!secret) {
    throw new StorageTokenError("Cannot sign storage token without a secret");
  }
  const encodedPayload = base64urlEncode(JSON.stringify(payload));
  const signature = createHmac("sha256", secret).update(encodedPayload).digest();
  return `${encodedPayload}.${base64urlEncode(signature)}`;
}

/**
 * Verify a storage token: checks the signature (constant-time) THEN the expiry.
 * Returns the decoded payload, or throws `StorageTokenError`. A caller must
 * still confirm the payload's `key`/`op` match the request it's serving.
 */
export function verifyStorageToken(
  token: string,
  secret: string,
  now: number = Math.floor(Date.now() / 1000),
): StorageTokenPayload {
  if (!secret) {
    throw new StorageTokenError("Cannot verify storage token without a secret");
  }
  const parts = token.split(".");
  if (parts.length !== 2) {
    throw new StorageTokenError("Malformed storage token");
  }
  const [encodedPayload, encodedSignature] = parts;

  const expected = createHmac("sha256", secret).update(encodedPayload).digest();
  const provided = base64urlDecode(encodedSignature);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new StorageTokenError("Storage token signature mismatch");
  }

  let payload: StorageTokenPayload;
  try {
    payload = JSON.parse(base64urlDecode(encodedPayload).toString("utf8")) as StorageTokenPayload;
  } catch {
    throw new StorageTokenError("Storage token payload is not valid JSON");
  }

  if (typeof payload.exp !== "number" || now >= payload.exp) {
    throw new StorageTokenError("Storage token has expired");
  }
  return payload;
}
