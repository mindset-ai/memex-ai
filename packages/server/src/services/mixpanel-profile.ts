// Mixpanel People (/engage) profile slice (spec-297 dec-7).
//
// The platform only ever called /track before this (events, not people), so the
// Mixpanel Users tab was empty. This module sets a small, opaque user PROFILE per
// user so internal users are filterable and per-org cohorting works:
//   - email_domain — the DOMAIN ONLY (never the full email, never the name —
//     std-35 cl-31). "Real users" = exclude email_domain = 'mindset.ai'.
//   - org_ids      — the user's org link(s) as opaque org ids (never PII).
//
// Same PII line and gating as the /track sink: opaque distinct_id (user UUID),
// no PII in any property, server-side only, US host, $ip='0' (no IP geo, dec-4),
// and forwarding gated SOLELY on the Mindset-only MIXPANEL_TOKEN — a self-hosted
// instance with no token sends nothing (dec-5). Every send is advisory.

import { and, eq } from "drizzle-orm";
import { db, type Db } from "../db/connection.js";
import { orgMemberships, users } from "../db/schema.js";

// US ingestion host (dec-9 — EU is deliberately out of scope), People endpoint.
const MIXPANEL_ENGAGE_URL = "https://api.mixpanel.com/engage";

function log(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.error("[mixpanel-profile]", ...args);
}

/**
 * The DOMAIN part of an email, lowercased — never the local part, never the whole
 * address. Returns null for a malformed address so we never set a junk property.
 */
export function extractEmailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain.length > 0 ? domain : null;
}

export interface UserProfileInput {
  /** Opaque user UUID — the Mixpanel distinct_id. */
  userId: string;
  /** Domain only (from extractEmailDomain). Omitted from $set when null. */
  emailDomain: string | null;
  /** Opaque org ids. May be empty. */
  orgIds: readonly string[];
}

/**
 * A Mixpanel /engage profile update WITHOUT the token — the sink stamps $token at
 * send time (mirrors how the /track sink owns the token). Carries ONLY opaque,
 * non-PII properties: email_domain (domain only) and org_ids. No $email, no $name,
 * no full address ever. $ip='0' suppresses IP geolocation (dec-4).
 */
export interface EngageProfile {
  $distinct_id: string;
  $ip: "0";
  $set: Record<string, unknown>;
}

/** Map a user to a Mixpanel /engage $set payload (token-free). Pure — unit-tested. */
export function toEngagePayload(input: UserProfileInput): EngageProfile {
  const $set: Record<string, unknown> = {};
  if (input.emailDomain) $set.email_domain = input.emailDomain;
  // Always set org_ids (even empty) so a user who left every org is updated to [].
  $set.org_ids = [...input.orgIds];
  return {
    $distinct_id: input.userId,
    $ip: "0",
    $set,
  };
}

export interface ProfileSink {
  readonly name: string;
  setProfiles(profiles: readonly EngageProfile[]): Promise<void>;
}

export class MixpanelProfileSink implements ProfileSink {
  readonly name = "mixpanel-profile";

  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async setProfiles(profiles: readonly EngageProfile[]): Promise<void> {
    if (profiles.length === 0) return;
    // Stamp the token onto each profile at send time — the wire object Mixpanel
    // expects is { $token, $distinct_id, $ip, $set }.
    const payload = profiles.map((p) => ({ $token: this.token, ...p }));
    const res = await this.fetchImpl(MIXPANEL_ENGAGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/plain" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`Mixpanel /engage returned ${res.status}`);
    }
  }
}

/**
 * The configured profile sink, or null when forwarding is disabled. Gated SOLELY
 * on MIXPANEL_TOKEN (dec-5) — no token ⇒ no sink ⇒ a self-hosted instance forwards
 * no profiles. Mirrors usage-forwarder.configuredSink.
 */
export function configuredProfileSink(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): ProfileSink | null {
  const token = env.MIXPANEL_TOKEN?.trim();
  if (!token) return null;
  return new MixpanelProfileSink(token, fetchImpl);
}

/** A user's distinct active-org ids (opaque). Empty for personal-only users. */
export async function getUserOrgIds(userId: string, conn: Db = db): Promise<string[]> {
  const rows = await conn
    .selectDistinct({ orgId: orgMemberships.orgId })
    .from(orgMemberships)
    .where(and(eq(orgMemberships.userId, userId), eq(orgMemberships.status, "active")));
  return rows.map((r) => r.orgId);
}

/**
 * Build + send one user's Mixpanel profile. Advisory: any failure (lookup, gate,
 * network) is logged and swallowed so it never disturbs the calling path. No-op
 * when no token is configured (self-hosted). Returns the payload that was sent, or
 * null when skipped — handy for tests.
 */
export async function syncUserProfile(
  userId: string,
  opts: { sink?: ProfileSink | null; conn?: Db } = {},
): Promise<EngageProfile | null> {
  try {
    const sink = opts.sink !== undefined ? opts.sink : configuredProfileSink();
    if (!sink) return null; // capture-only / self-hosted — nothing to forward
    const conn = opts.conn ?? db;
    const [user] = await conn.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) return null;
    const orgIds = await getUserOrgIds(userId, conn);
    const payload = toEngagePayload({
      userId,
      emailDomain: extractEmailDomain(user.email),
      orgIds,
    });
    await sink.setProfiles([payload]);
    return payload;
  } catch (err) {
    log("syncUserProfile failed (advisory — swallowed):", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * One-off backfill (dec-7): set email_domain + org links for ALL existing users so
 * the Mixpanel Users tab is complete from day one, not only for users active after
 * the slice ships. Idempotent ($engage $set is an upsert) — safe to re-run. No-op
 * when no token is configured (self-hosted). Batches the /engage sends.
 */
export async function backfillAllUserProfiles(
  opts: { sink?: ProfileSink | null; conn?: Db; batchSize?: number } = {},
): Promise<{ total: number; sent: number }> {
  const sink = opts.sink !== undefined ? opts.sink : configuredProfileSink();
  if (!sink) {
    log("no MIXPANEL_TOKEN configured — capture-only, backfill is a no-op");
    return { total: 0, sent: 0 };
  }
  const conn = opts.conn ?? db;
  const allUsers = await conn.select({ id: users.id, email: users.email }).from(users);
  // Per-user resilience: a backfill must not abort because ONE user's org lookup
  // throws (e.g. the row was deleted by a concurrent path mid-scan). Build each
  // profile in its own try/catch and drop the failures, so one odd user can't take
  // down the whole backfill — matching syncUserProfile's advisory-swallow posture.
  // (This also removes the std-37 race where a sibling test deleting a user
  // mid-Promise.all rejected the whole call and reddened the merge gate — spec-395.)
  const built = await Promise.all(
    allUsers.map(async (u) => {
      try {
        return toEngagePayload({
          userId: u.id,
          emailDomain: extractEmailDomain(u.email),
          orgIds: await getUserOrgIds(u.id, conn),
        });
      } catch (err) {
        log(
          "backfillAllUserProfiles: skipped one user (advisory — swallowed):",
          err instanceof Error ? err.message : err,
        );
        return null;
      }
    }),
  );
  const profiles = built.filter((p): p is EngageProfile => p !== null);
  const batchSize = opts.batchSize ?? 200;
  let sent = 0;
  for (let i = 0; i < profiles.length; i += batchSize) {
    const batch = profiles.slice(i, i + batchSize);
    await sink.setProfiles(batch);
    sent += batch.length;
  }
  // `total` is the count we actually built a profile for (sent === total holds), so a
  // user dropped above doesn't desync the two — the caller's "every profile sent"
  // invariant stays true regardless of a concurrently-mutated sibling row.
  return { total: profiles.length, sent };
}
