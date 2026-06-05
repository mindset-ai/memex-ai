// E2E test fixtures — unique-per-test factories, resource tracking, and cleanup.
// Each test file imports `test` from here instead of "@playwright/test" to get
// per-test dev-user baseline reset + automatic teardown of seeded resources.
//
// Per spec-172 dec-2/dec-3 the fixture talks ONLY to the server's test-only HTTP
// surface (helpers/seed.ts) — no Postgres, no SQL. Navigation is PATH-based on
// the single origin [per std-2]: `/<namespace>/<memex>/...`, never subdomains.

import { test as base } from "@playwright/test";
import {
  ensureUser,
  setUserName,
  clearOrgMemberships,
  cleanup,
} from "./seed.js";

export const DEV_EMAIL = "dev@memex.ai";
export const DEV_NAME = "Dev User";

export interface TestResources {
  /** Namespace slugs a test created — torn down (with everything under them) in afterEach. */
  namespaceSlugs: string[];
  /** Loose doc ids a test created outside a tracked namespace. */
  docIds: string[];
  /** Emails a test created — for symmetry with namespace cleanup; dev is never deleted. */
  emails: string[];
  /** Per-test unique suffix so slugs/emails don't collide across runs. */
  uniq: string;
  /** Build a per-test-unique slug: `${prefix}-${uniq}` (lowercased). Auto-tracked for cleanup. */
  slug: (prefix: string) => string;
  /** Build a per-test-unique email: `${prefix}-${uniq}@${domain}`. Auto-tracked. */
  email: (prefix: string, domain?: string) => string;
}

export const test = base.extend<{ resources: TestResources }>({
  resources: async ({}, use) => {
    // Baseline reset of the dev user BEFORE each test (the schema-current
    // equivalent of the old clearMembershipsForEmail + named seedUser):
    //   1. ensure dev@memex.ai exists with its personal namespace + memex,
    //   2. drop every org membership so a stale team row can't alter the
    //      switcher/router decision,
    //   3. re-set the display name so a journey that cleared it (onboarding)
    //      can't leak a nameless dev user into the next test.
    await ensureUser(DEV_EMAIL);
    await clearOrgMemberships(DEV_EMAIL);
    await setUserName(DEV_EMAIL, DEV_NAME);

    const uniq = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const namespaceSlugs: string[] = [];
    const docIds: string[] = [];
    const emails: string[] = [];

    const resources: TestResources = {
      namespaceSlugs,
      docIds,
      emails,
      uniq,
      slug: (prefix) => {
        const s = `${prefix}-${uniq}`.toLowerCase();
        namespaceSlugs.push(s);
        return s;
      },
      email: (prefix, domain = "example.com") => {
        const e = `${prefix}-${uniq}@${domain}`;
        emails.push(e);
        return e;
      },
    };

    await use(resources);

    // Teardown: drop tracked namespaces (cascading memexes/orgs/docs) and any
    // loose docs. Best-effort — a failed cleanup never fails the test.
    try {
      if (namespaceSlugs.length || docIds.length) {
        await cleanup({ namespaceSlugs, docIds });
      }
    } catch {
      // Swallow — cleanup is best-effort; the next test re-asserts dev baseline.
    }
  },
});

export { expect } from "@playwright/test";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:5173";

/**
 * Path-based tenant URL [per std-2]: resolves `/<namespace>/<memex>${path}` on
 * the single origin. There is NO subdomain form — the account-era tenantUrl
 * (which built `<sub>.host`) was removed with the account-era journeys (dec-1).
 */
export function tenantPath(
  namespace: string,
  memex: string,
  path: string = "/"
): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return new URL(`/${namespace}/${memex}${suffix === "/" ? "" : suffix}`, BASE_URL).toString();
}

/** A bare (non-tenant) URL on the single origin — login, signup, invite-accept, etc. */
export function bareUrl(path: string = "/"): string {
  return new URL(path, BASE_URL).toString();
}
