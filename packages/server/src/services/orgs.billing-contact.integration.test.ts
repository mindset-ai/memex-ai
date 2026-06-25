// spec-171 t-1: billing contact designation.
//
// Verifies that an org can designate a billing contact (email + name) that
// is separate from the org creator / admin. The billing contact is stored on
// the orgs table and returned via OrgSummary; admins can update it any time.
//
// AC emission: tagAc(AC) on the assertion that proves the feature is delivered.

import { describe, it, expect, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { namespaces } from "../db/schema.js";
import { createOrgWithOwner, getOrgSummary, updateOrgSettings } from "./orgs.js";
import { upsertUserByEmail } from "./users.js";
import { tagAc } from "@memex-ai-ac/vitest";

const AC32 = "mindset-prod/memex-building-itself/specs/spec-171/acs/ac-32";

const createdNamespaceIds: string[] = [];
const createdUserIds: string[] = [];

afterAll(async () => {
  if (createdNamespaceIds.length) {
    await db.delete(namespaces).where(inArray(namespaces.id, createdNamespaceIds)).catch(() => {});
  }
});

function uniqueSlug(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toLowerCase();
}

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

async function seedOrg(slugPrefix: string) {
  const user = await upsertUserByEmail(uniqueEmail("billing-test"));
  createdUserIds.push(user.id);
  const slug = uniqueSlug(slugPrefix);
  const result = await createOrgWithOwner({ slug, name: "Billing Test Org", ownerUserId: user.id });
  createdNamespaceIds.push(result.namespace.id);
  return result;
}

describe("billing contact designation (spec-171 t-1)", () => {
  it("billing_contact_email and billing_contact_name default to null on a new org", async () => {
    const { org } = await seedOrg("bc-default");
    const summary = await getOrgSummary(org.id);
    expect(summary).not.toBeNull();
    expect(summary!.billingContactEmail).toBe(null);
    expect(summary!.billingContactName).toBe(null);
    tagAc(AC32);
  });

  it("updateOrgSettings persists billing contact email and name", async () => {
    const { org } = await seedOrg("bc-set");
    await updateOrgSettings(org.id, {
      billingContactEmail: "finance@acme.com",
      billingContactName: "Finance Team",
    });
    const summary = await getOrgSummary(org.id);
    expect(summary!.billingContactEmail).toBe("finance@acme.com");
    expect(summary!.billingContactName).toBe("Finance Team");
    tagAc(AC32);
  });

  it("updateOrgSettings can clear billing contact back to null", async () => {
    const { org } = await seedOrg("bc-clear");
    await updateOrgSettings(org.id, {
      billingContactEmail: "cfo@acme.com",
      billingContactName: "CFO",
    });
    await updateOrgSettings(org.id, {
      billingContactEmail: null,
      billingContactName: null,
    });
    const summary = await getOrgSummary(org.id);
    expect(summary!.billingContactEmail).toBe(null);
    expect(summary!.billingContactName).toBe(null);
    tagAc(AC32);
  });

  it("updateOrgSettings rejects an invalid billing contact email format", async () => {
    const { org } = await seedOrg("bc-invalid");
    await expect(
      updateOrgSettings(org.id, { billingContactEmail: "not-an-email" }),
    ).rejects.toThrow("Invalid billing contact email");
    tagAc(AC32);
  });
});
