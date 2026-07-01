// spec-427 t-5 (ac-8) — evaluateActivationState against the real DB: cohorts are
// derived from the users row + funnel state (usage_events), never account.created.
// The load-bearing case (ac-8): a signed-in-dormant user with NO account.created event
// (as an SSO / magic-link signup would be) is still correctly evaluated for Email 2.
import { afterEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { users, usageEvents } from "../db/schema.js";
import { evaluateActivationState } from "./activation-cohort.js";

const AC8 = "mindset-prod/memex-building-itself/specs/spec-427/acs/ac-8";

const created: string[] = [];
async function seedUser(email: string, emailVerifiedAt: Date | null): Promise<string> {
  const [u] = await db.insert(users).values({ email, emailVerifiedAt }).returning({ id: users.id });
  created.push(u!.id);
  return u!.id;
}

afterEach(async () => {
  if (created.length) {
    await db.delete(usageEvents).where(inArray(usageEvents.actorUserId, created)).catch(() => {});
    await db.delete(users).where(inArray(users.id, created)).catch(() => {});
    created.length = 0;
  }
});

describe("evaluateActivationState (ac-8)", () => {
  it("signed-in-but-dormant WITHOUT an account.created event → Email 2, anchored on email_verified_at", async () => {
    tagAc(AC8);
    const verifiedAt = new Date("2026-06-10T09:00:00Z");
    const userId = await seedUser("spec427-t5-sso@example.test", verifiedAt);
    // Deliberately emit NO account.created (the SSO/magic-link case ac-8 guards).

    const state = await evaluateActivationState(userId);
    expect(state.cohort).toBe("signed_in_dormant");
    expect(state.enteredAt?.getTime()).toBe(verifiedAt.getTime());
  });

  it("connected-but-inactive → Email 1, anchored on the first mcp.connected event", async () => {
    tagAc(AC8);
    const userId = await seedUser("spec427-t5-connected@example.test", new Date());
    const connectedAt = new Date("2026-06-12T12:00:00Z");
    await db.insert(usageEvents).values({ actorUserId: userId, name: "mcp.connected", source: "backend", env: "test", occurredAt: connectedAt });

    const state = await evaluateActivationState(userId);
    expect(state.cohort).toBe("connected_inactive");
    expect(state.enteredAt?.getTime()).toBe(connectedAt.getTime());
  });

  it("a connected user who has called a tool is activated → neither email", async () => {
    tagAc(AC8);
    const userId = await seedUser("spec427-t5-active@example.test", new Date());
    await db.insert(usageEvents).values([
      { actorUserId: userId, name: "mcp.connected", source: "backend", env: "test" },
      { actorUserId: userId, name: "mcp.tool_called", source: "backend", env: "test" },
    ]);

    const state = await evaluateActivationState(userId);
    expect(state.cohort).toBeNull();
    expect(state.enteredAt).toBeNull();
  });

  it("an unknown user resolves to no cohort", async () => {
    tagAc(AC8);
    const state = await evaluateActivationState("00000000-0000-0000-0000-000000000000");
    expect(state.cohort).toBeNull();
  });
});
