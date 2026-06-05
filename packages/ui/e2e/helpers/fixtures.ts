// E2E test fixtures — unique-per-test names and cleanup tracking. Each test file should
// import `test` from here instead of "@playwright/test" to get per-test cleanup automatically.

import { test as base } from "@playwright/test";
import {
  deleteAccounts,
  deleteUsersByEmail,
  seedUser,
  seedMembership,
  clearMembershipsForEmail,
  ensurePersonalAccount,
} from "./db.js";

export interface TestResources {
  accountIds: string[];
  emails: string[];
  uniq: string;
  subdomain: (prefix: string) => string;
  email: (prefix: string, domain?: string) => string;
  /** Ensure dev@memex.ai is the admin of the given account before the test runs. */
  devAsAdmin: (accountId: string) => Promise<string>;
}

export const test = base.extend<{ resources: TestResources }>({
  resources: async ({}, use) => {
    // Reset dev@memex.ai's TEAM membership state before each test — stale rows from prior
    // runs would alter the switcher's team list and confuse per-journey expectations.
    // Personal membership is preserved (every user has one, always). Also ensure the dev
    // user has a name set so tests skip onboarding by default, and that a personal account
    // exists for the new GitHub-style default routing.
    await clearMembershipsForEmail("dev@memex.ai");
    const devId = await seedUser("dev@memex.ai", "Dev User");
    await ensurePersonalAccount(devId);

    const uniq = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const accountIds: string[] = [];
    const emails: string[] = [];
    const resources: TestResources = {
      accountIds,
      emails,
      uniq,
      subdomain: (prefix) => `${prefix}-${uniq}`.toLowerCase(),
      email: (prefix, domain = "example.com") => {
        const e = `${prefix}-${uniq}@${domain}`;
        emails.push(e);
        return e;
      },
      devAsAdmin: async (accountId) => {
        const devId = await seedUser("dev@memex.ai");
        await seedMembership(devId, accountId, "administrator");
        return devId;
      },
    };
    await use(resources);
    // Cleanup: cascade-delete via accounts, then extra users
    await deleteAccounts(accountIds);
    await deleteUsersByEmail(emails.filter((e) => e !== "dev@memex.ai"));
  },
});

export { expect } from "@playwright/test";

// Constructs the full admin URL for a tenant subdomain at the local port. Kept as a helper
// so tests don't duplicate the string interpolation.
export function tenantUrl(subdomain: string, path: string = "/"): string {
  const base = process.env.E2E_BASE_URL ?? "http://localhost:5173";
  const url = new URL(path, base);
  url.host = `${subdomain}.${url.host}`;
  return url.toString();
}

export function bareUrl(path: string = "/"): string {
  const base = process.env.E2E_BASE_URL ?? "http://localhost:5173";
  return new URL(path, base).toString();
}
