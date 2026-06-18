// spec-171 t-5: Self-hosted license key generation and validation.
// Hand-rolled HS256 JWT via node:crypto — no jsonwebtoken / jose per std-13.
// Secret stored in GCP Secret Manager as LICENSE_SIGNING_SECRET per std-9.

import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { selfHostedLicenses } from "../db/schema.js";

// ── JWT primitives ────────────────────────────────────────────────────────────

function base64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function base64urlDecode(str: string): Buffer {
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function jwtSign(headerDotPayload: string, secret: string): string {
  return base64urlEncode(
    createHmac("sha256", secret).update(headerDotPayload).digest(),
  );
}

// ── License payload ───────────────────────────────────────────────────────────

export interface LicensePayload {
  license_id: string;
  org_id: string | null;
  seats_purchased: number;
  valid_until: string; // ISO 8601
  tier: "trial" | "commercial";
}

// ── Secret accessor ───────────────────────────────────────────────────────────

function getLicenseSigningSecret(): string {
  const secret = process.env.LICENSE_SIGNING_SECRET;
  if (!secret) throw new Error("LICENSE_SIGNING_SECRET is not set");
  if (secret.length < 32) throw new Error("LICENSE_SIGNING_SECRET must be at least 32 characters");
  return secret;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate a signed license key JWT, persist the license record, and return the
 * raw JWT string for delivery to the customer (email + download page display).
 */
export async function generateLicenseKey(
  orgId: string | null,
  seatsPurchased: number,
  tier: "trial" | "commercial",
  validDays: number,
): Promise<string> {
  const secret = getLicenseSigningSecret();

  const validUntil = new Date();
  validUntil.setDate(validUntil.getDate() + validDays);
  const validUntilIso = validUntil.toISOString();

  // Insert the license row first to get the UUID
  const [license] = await db
    .insert(selfHostedLicenses)
    .values({
      orgId: orgId ?? undefined,
      licenseKey: "pending", // replaced below once we have the id
      seatsPurchased,
      validUntil: new Date(validUntilIso),
      tier,
    })
    .returning({ id: selfHostedLicenses.id });

  const payload: LicensePayload = {
    license_id: license.id,
    org_id: orgId,
    seats_purchased: seatsPurchased,
    valid_until: validUntilIso,
    tier,
  };

  const header = base64urlEncode(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = base64urlEncode(Buffer.from(JSON.stringify(payload)));
  const sig = jwtSign(`${header}.${body}`, secret);
  const jwt = `${header}.${body}.${sig}`;

  // Update the row with the real JWT
  await db
    .update(selfHostedLicenses)
    .set({ licenseKey: jwt })
    .where(eq(selfHostedLicenses.id, license.id));

  return jwt;
}

/**
 * Verify a license key JWT signature and expiry, returning the parsed payload.
 * Throws a descriptive error if the key is invalid, expired, or malformed.
 */
export function validateLicenseKey(token: string): LicensePayload {
  const secret = getLicenseSigningSecret();
  const parts = token.split(".");

  if (parts.length !== 3) {
    throw new LicenseKeyError("malformed", "Invalid license key format");
  }

  const [header, payloadPart, sig] = parts;

  // Timing-safe signature comparison
  const expectedSig = jwtSign(`${header}.${payloadPart}`, secret);
  const sigBuf = Buffer.from(sig + "=".repeat((4 - (sig.length % 4)) % 4), "base64");
  const expectedBuf = Buffer.from(
    expectedSig + "=".repeat((4 - (expectedSig.length % 4)) % 4),
    "base64",
  );
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    throw new LicenseKeyError("invalid_signature", "License key signature is invalid");
  }

  let payload: LicensePayload;
  try {
    payload = JSON.parse(base64urlDecode(payloadPart).toString("utf8")) as LicensePayload;
  } catch {
    throw new LicenseKeyError("malformed", "License key payload could not be parsed");
  }

  if (!payload.valid_until || new Date(payload.valid_until) < new Date()) {
    throw new LicenseKeyError("expired", "License key has expired");
  }

  return payload;
}

export class LicenseKeyError extends Error {
  constructor(
    public readonly reason: "malformed" | "invalid_signature" | "expired",
    message: string,
  ) {
    super(message);
    this.name = "LicenseKeyError";
  }
}
