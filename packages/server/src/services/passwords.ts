// Password hashing using Node's built-in scrypt — no dependency on bcrypt or argon2.
// scrypt is OWASP-recommended and available in node:crypto since v10.5.
//
// Storage format: scrypt$N$r$p$<base64-salt>$<base64-hash>
// We pin parameters (N=16384, r=8, p=1, 32-byte salt, 64-byte hash) — good balance
// between CPU cost (~60ms) and memory (16MB per hash) on a modern laptop. If the
// parameters change we can add format-version detection later.

import { scrypt, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { ValidationError } from "../types/errors.js";

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number }
) => Promise<Buffer>;

const PARAMS = { N: 16384, r: 8, p: 1 };
const SALT_BYTES = 32;
const HASH_BYTES = 64;

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 256;

export function validatePasswordStrength(password: string): void {
  if (typeof password !== "string") {
    throw new ValidationError("Password is required");
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new ValidationError(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters`
    );
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new ValidationError(
      `Password must be at most ${MAX_PASSWORD_LENGTH} characters`
    );
  }
}

export async function hashPassword(password: string): Promise<string> {
  validatePasswordStrength(password);
  const salt = randomBytes(SALT_BYTES);
  const derived = await scryptAsync(password, salt, HASH_BYTES, PARAMS);
  return [
    "scrypt",
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString("base64"),
    derived.toString("base64"),
  ].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (typeof stored !== "string" || !stored.startsWith("scrypt$")) return false;
  const parts = stored.split("$");
  if (parts.length !== 6) return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltB64, "base64");
    expected = Buffer.from(hashB64, "base64");
  } catch {
    return false;
  }

  const actual = await scryptAsync(password, salt, expected.length, { N, r, p });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
