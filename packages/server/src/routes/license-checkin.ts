// spec-171 t-5: License check-in endpoint for self-hosted instances.
//
// POST /api/license/checkin — unauthenticated (the license JWT is the credential).
// Self-hosted instances call this once per day to report seat count + fingerprint.
// Rate-limited to one checkin per license per 23 hours (allows daily cadence with
// small drift tolerance).

import { Hono } from "hono";
import { and, desc, gte, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { licenseCheckins } from "../db/schema.js";
import { validateLicenseKey, LicenseKeyError } from "../services/license-keys.js";

const licenseCheckinRouter = new Hono();

// 23 hours in milliseconds — allows one checkin per day with drift tolerance
const RATE_WINDOW_MS = 23 * 60 * 60 * 1000;

licenseCheckinRouter.post("/", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  const { license_key, reported_seat_count, instance_fingerprint } = body;

  if (typeof license_key !== "string" || !license_key.trim()) {
    return c.json({ error: "license_key is required" }, 400);
  }
  if (typeof reported_seat_count !== "number" || reported_seat_count < 0) {
    return c.json({ error: "reported_seat_count must be a non-negative number" }, 400);
  }
  if (typeof instance_fingerprint !== "string" || !instance_fingerprint.trim()) {
    return c.json({ error: "instance_fingerprint is required" }, 400);
  }

  // Validate the license key JWT
  let payload;
  try {
    payload = validateLicenseKey(license_key.trim());
  } catch (err) {
    if (err instanceof LicenseKeyError) {
      const status = err.reason === "expired" ? 403 : 401;
      return c.json({ error: err.message, reason: err.reason }, status);
    }
    throw err;
  }

  // Rate limit: one checkin per license per 23 hours
  const windowStart = new Date(Date.now() - RATE_WINDOW_MS);
  const recent = await db
    .select({ id: licenseCheckins.id })
    .from(licenseCheckins)
    .where(
      and(
        eq(licenseCheckins.licenseId, payload.license_id),
        gte(licenseCheckins.checkedInAt, windowStart),
      ),
    )
    .limit(1);

  if (recent.length > 0) {
    return c.json(
      { error: "Checkin rate limit exceeded — one checkin per 23 hours per license" },
      429,
    );
  }

  await db.insert(licenseCheckins).values({
    licenseId: payload.license_id,
    reportedSeatCount: reported_seat_count as number,
    instanceFingerprint: (instance_fingerprint as string).trim(),
  });

  return c.json({ received: true, valid_until: payload.valid_until });
});

export { licenseCheckinRouter };
