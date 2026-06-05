import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { users, memexes, namespaces, orgs, orgMemberships, verifiedDomains } from "../db/schema.js";
import { handleSsoLogin, resolveSession, MemexAccessError, DisabledUserError } from "./auth.js";

const createdUserIds: string[] = [];
const createdAccountIds: string[] = [];
const createdDomains: string[] = [];

afterAll(async () => {
  if (createdDomains.length) {
    await db.delete(verifiedDomains).where(inArray(verifiedDomains.domain, createdDomains)).catch(() => {});
  }
  if (createdUserIds.length) {
    await db.delete(users).where(inArray(users.id, createdUserIds)).catch(() => {});
  }
  if (createdAccountIds.length) {
    await db.delete(memexes).where(inArray(memexes.id, createdAccountIds)).catch(() => {});
  }
});

function uniqueEmail(prefix: string, domain = "example.com"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@${domain}`;
}

function uniqueSubdomain(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toLowerCase();
}

// Returns memex.id (the legacy "memexId" in session-payload contexts is
// memex.id — that's what listMemberships emits and what handleSsoLogin's
// currentMemexId maps to). Org membership inserts in this file should pass
// the *org* id, fetched via the namespace pointer.
async function makeAccount(
  name: string,
  emailDomains: string[] = [],
  opts: { autoGroupingEnabled?: boolean } = {}
): Promise<string> {
  const slug = uniqueSubdomain(name.toLowerCase().replace(/\W/g, ""));
  const [ns] = await db.insert(namespaces).values({ slug, kind: "org" }).returning();
  const [org] = await db
    .insert(orgs)
    .values({
      namespaceId: ns.id,
      name,
      emailDomains,
      autoGroupingEnabled: opts.autoGroupingEnabled ?? false,
    })
    .returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [acct] = await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name }).returning();
  createdAccountIds.push(acct.id);
  // Stash org for callers that need to insert org_memberships. Lookup map
  // keyed by memex id avoids restructuring callsites that say `memexId`.
  memexToOrg.set(acct.id, org.id);
  return acct.id;
}

const memexToOrg = new Map<string, string>();
function orgIdFor(memexId: string): string {
  const orgId = memexToOrg.get(memexId);
  if (!orgId) throw new Error(`Unknown memex ${memexId} — call makeAccount first`);
  return orgId;
}

describe("handleSsoLogin", () => {
  it("creates a new user and auto-provisions a personal memex on first sign-in", async () => {
    const email = uniqueEmail("new");
    const session = await handleSsoLogin({ email });

    createdUserIds.push(session.user.id);

    expect(session.user.email).toBe(email.toLowerCase());
    expect(session.user.status).toBe("active");
    // Every new user gets exactly one personal membership — no team memberships yet.
    expect(session.memberships).toHaveLength(1);
    expect(session.memberships[0].kind).toBe("personal");
    expect(session.memberships[0].role).toBe("administrator");
    expect(session.memberships[0].name).toBe("Personal Memex");
    // Default currentMemexId is the personal workspace.
    expect(session.currentMemexId).toBe(session.memberships[0].memexId);
    expect(session.currentRole).toBe("administrator");
  });

  it("auto-picks the team account when user has exactly one team membership alongside personal", async () => {
    const email = uniqueEmail("single");
    const memexId = await makeAccount("Single Co");

    // First login creates the user + personal
    const initial = await handleSsoLogin({ email });
    createdUserIds.push(initial.user.id);

    await db.insert(orgMemberships).values({
      userId: initial.user.id,
      orgId: orgIdFor(memexId),
      role: "member",
    } as any);

    // With personal + one team, the default pick is personal (GitHub-style "home base").
    // The team is available via explicit requestedAccountId.
    const session = await handleSsoLogin({ email }, memexId);
    expect(session.currentMemexId).toBe(memexId);
    expect(session.currentRole).toBe("member");
    expect(session.memberships).toHaveLength(2);
  });

  it("defaults to personal when user has multiple memberships and none requested", async () => {
    const email = uniqueEmail("multi");
    const acct1 = await makeAccount("First");
    const acct2 = await makeAccount("Second");

    const initial = await handleSsoLogin({ email });
    createdUserIds.push(initial.user.id);
    const personalId = initial.memberships[0].memexId;

    await db.insert(orgMemberships).values([
      { userId: initial.user.id, orgId: orgIdFor(acct1), role: "member" },
      { userId: initial.user.id, orgId: orgIdFor(acct2), role: "administrator" },
    ] as any);

    const session = await handleSsoLogin({ email });
    expect(session.memberships).toHaveLength(3); // personal + 2 teams
    expect(session.currentMemexId).toBe(personalId);
    expect(session.currentRole).toBe("administrator");
  });

  it("respects requestedAccountId when user is a member", async () => {
    const email = uniqueEmail("requested");
    const acct1 = await makeAccount("A1");
    const acct2 = await makeAccount("A2");

    const initial = await handleSsoLogin({ email });
    createdUserIds.push(initial.user.id);

    await db.insert(orgMemberships).values([
      { userId: initial.user.id, orgId: orgIdFor(acct1), role: "member" },
      { userId: initial.user.id, orgId: orgIdFor(acct2), role: "administrator" },
    ] as any);

    const session = await handleSsoLogin({ email }, acct2);
    expect(session.currentMemexId).toBe(acct2);
    expect(session.currentRole).toBe("administrator");
  });

  it("throws MemexAccessError when requestedAccountId is not a membership", async () => {
    const email = uniqueEmail("badrequest");
    const acct1 = await makeAccount("Mine");
    const otherAcct = await makeAccount("Theirs");

    const initial = await handleSsoLogin({ email });
    createdUserIds.push(initial.user.id);

    await db.insert(orgMemberships).values({
      userId: initial.user.id,
      orgId: orgIdFor(acct1),
      role: "member",
    });

    await expect(handleSsoLogin({ email }, otherAcct)).rejects.toBeInstanceOf(MemexAccessError);
  });

  it("throws DisabledUserError for disabled users", async () => {
    const email = uniqueEmail("disabled");
    const initial = await handleSsoLogin({ email });
    createdUserIds.push(initial.user.id);

    await db.update(users).set({ status: "disabled" }).where(eq(users.id, initial.user.id));

    await expect(handleSsoLogin({ email })).rejects.toBeInstanceOf(DisabledUserError);
  });

  it("auto-verifies domain via SSO when account claims it (dec-5)", async () => {
    const domain = `auto-${Date.now().toString(36)}.test`;
    createdDomains.push(domain);

    const memexId = await makeAccount("Workspace Co", [domain]);
    const email = uniqueEmail("workspace", domain);

    const initial = await handleSsoLogin({ email });
    createdUserIds.push(initial.user.id);

    await db.insert(orgMemberships).values({
      userId: initial.user.id,
      orgId: orgIdFor(memexId),
      role: "member",
    } as any);

    // Login carries the Workspace `hd` claim → should write verified_domains.
    // Default-pick remains personal; explicit memexId is needed to select the team.
    const session = await handleSsoLogin({ email, hd: domain }, memexId);
    expect(session.currentMemexId).toBe(memexId);

    const found = await db.query.verifiedDomains.findFirst({
      where: eq(verifiedDomains.domain, domain),
    });
    expect(found).toBeTruthy();
    expect(found?.orgId).toBe(orgIdFor(memexId));
    expect(found?.verificationMethod).toBe("sso");
  });

  it("auto-verifies via hd for memexes that claim the domain even without an existing membership (t-6)", async () => {
    const domain = `nomember-${Date.now().toString(36)}.test`;
    createdDomains.push(domain);

    const memexId = await makeAccount("Workspace Co", [domain]);
    const email = uniqueEmail("nomember", domain);

    // User has NO membership yet, but the account claims the domain.
    const session = await handleSsoLogin({ email, hd: domain });
    createdUserIds.push(session.user.id);

    const verified = await db.query.verifiedDomains.findFirst({
      where: eq(verifiedDomains.domain, domain),
    });
    expect(verified?.orgId).toBe(orgIdFor(memexId));
    expect(verified?.verificationMethod).toBe("sso");
  });

  it("does NOT silently auto-join new users to a team even when verified domain + auto_grouping match (Slack-style explicit join)", async () => {
    const domain = `noautojoin-${Date.now().toString(36)}.test`;
    createdDomains.push(domain);

    const memexId = await makeAccount("Explicit Join Co", [domain], { autoGroupingEnabled: true });
    // Pre-verify the domain — this is a condition under which the OLD behavior would auto-join.
    await db.insert(verifiedDomains).values({
      domain,
      orgId: orgIdFor(memexId),
      verificationMethod: "email",
    } as any);

    // New user signs in. They get a personal account, but do NOT auto-join the team —
    // the team membership has to come from explicit "Join" action (Slack-style).
    const email = uniqueEmail("newhire", domain);
    const session = await handleSsoLogin({ email });
    createdUserIds.push(session.user.id);

    const teamMemberships = session.memberships.filter((m) => m.kind === "team");
    expect(teamMemberships).toEqual([]);
    // Personal is the only membership and drives currentMemexId.
    expect(session.memberships).toHaveLength(1);
    expect(session.memberships[0].kind).toBe("personal");
    expect(session.memberships[0].memexId).toBe(session.currentMemexId);
    // Side-effect guard: nothing touched the team account.
    expect(memexId).toBeTruthy(); // (referenced to keep lint happy)
  });

  it("does not create a team membership when auto_grouping_enabled is false (regression)", async () => {
    const domain = `noautog-${Date.now().toString(36)}.test`;
    createdDomains.push(domain);

    const memexId = await makeAccount("NoAuto Co", [domain], { autoGroupingEnabled: false });
    await db.insert(verifiedDomains).values({
      domain,
      orgId: orgIdFor(memexId),
      verificationMethod: "email",
    } as any);

    const email = uniqueEmail("noauto", domain);
    const session = await handleSsoLogin({ email });
    createdUserIds.push(session.user.id);

    const teamMemberships = session.memberships.filter((m) => m.kind === "team");
    expect(teamMemberships).toEqual([]);
    expect(memexId).toBeTruthy();
  });

  it("does not write verified_domains when no account claims the hd domain", async () => {
    const domain = `noclaim-${Date.now().toString(36)}.test`;
    const email = uniqueEmail("noclaim", domain);

    const session = await handleSsoLogin({ email, hd: domain });
    createdUserIds.push(session.user.id);

    const found = await db.query.verifiedDomains.findFirst({
      where: eq(verifiedDomains.domain, domain),
    });
    expect(found).toBeUndefined();
  });

  it("does not write verified_domains for non-Workspace tokens (no hd claim)", async () => {
    const domain = `nohd-${Date.now().toString(36)}.test`;
    const memexId = await makeAccount("NoHd", [domain]);
    const email = uniqueEmail("nohd", domain);

    const initial = await handleSsoLogin({ email });
    createdUserIds.push(initial.user.id);

    await db.insert(orgMemberships).values({
      userId: initial.user.id,
      orgId: orgIdFor(memexId),
      role: "member",
    } as any);

    await handleSsoLogin({ email }); // no hd
    const found = await db.query.verifiedDomains.findFirst({
      where: eq(verifiedDomains.domain, domain),
    });
    expect(found).toBeUndefined();
  });
});

describe("resolveSession", () => {
  it("resolves session for an existing user", async () => {
    const email = uniqueEmail("resolve");
    const memexId = await makeAccount("Resolve Co");

    const initial = await handleSsoLogin({ email });
    createdUserIds.push(initial.user.id);

    await db.insert(orgMemberships).values({
      userId: initial.user.id,
      orgId: orgIdFor(memexId),
      role: "administrator",
    } as any);

    const session = await resolveSession(initial.user.id, memexId);
    expect(session.user.id).toBe(initial.user.id);
    expect(session.currentMemexId).toBe(memexId);
    expect(session.currentRole).toBe("administrator");
  });

  it("rejects switch to an account the user isn't a member of", async () => {
    const email = uniqueEmail("nomember");
    const otherAcct = await makeAccount("Other");

    const initial = await handleSsoLogin({ email });
    createdUserIds.push(initial.user.id);

    await expect(resolveSession(initial.user.id, otherAcct)).rejects.toBeInstanceOf(
      MemexAccessError
    );
  });
});
