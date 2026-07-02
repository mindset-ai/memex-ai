import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";

// Force dev-mode auth so app.request() authenticates as dev@memex.ai without a
// minted JWT (same shape as qa-reports.integration.test.ts).
vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = "";
  return undefined;
});

import { db } from "../db/connection.js";
import { memexes, namespaces } from "../db/schema.js";
import { app } from "../app.js";
import { makeTestMemex, makeTestMemexWithDevAdmin } from "../services/test-helpers.js";
import { reconstructSkillMd } from "../services/skills/reconstruct-skill-md.js";

const AC_37 = "mindset-prod/memex-building-itself/specs/spec-300/acs/ac-37";

const SKILL_MD = reconstructSkillMd({
  name: "route-skill",
  description: "Created over REST. Use when: exercising the route.",
  body: "# Body\n\nText.",
});

let memberPath: string; // dev is administrator (write) here
let nonMemberPath: string; // dev is NOT a member here
const memexIds: string[] = [];

function withApexHost(init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers ?? {}), Host: "memex.ai" } };
}

beforeAll(async () => {
  const member = await makeTestMemexWithDevAdmin("skl-route-m");
  memberPath = `/api/${member.slug}/main`;
  memexIds.push(member.memexId);

  const outsiderId = await makeTestMemex("skl-route-x");
  memexIds.push(outsiderId);
  const [ns] = await db
    .select({ slug: namespaces.slug })
    .from(namespaces)
    .innerJoin(memexes, eq(memexes.namespaceId, namespaces.id))
    .where(eq(memexes.id, outsiderId))
    .limit(1);
  nonMemberPath = `/api/${ns!.slug}/main`;
});

afterAll(async () => {
  await db.delete(memexes).where(inArray(memexes.id, memexIds)).catch(() => {});
});

describe("POST /api/<ns>/<mx>/skills — write access (dec-15, std-7)", () => {
  it("a member with write access can create a skill (201)", async () => {
    tagAc(AC_37);

    const res = await app.request(
      `${memberPath}/skills`,
      withApexHost({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ skillMd: SKILL_MD }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { handle: string; name: string };
    expect(body.name).toBe("route-skill");
    expect(body.handle).toMatch(/^skill-\d+$/);

    // And the created skill is then listable + gettable over the same surface.
    const list = await app.request(`${memberPath}/skills`, withApexHost());
    expect(list.status).toBe(200);
    const skills = (await list.json()) as { handle: string }[];
    expect(skills.some((s) => s.handle === body.handle)).toBe(true);
  });

  it("a non-member is refused (404, not 403 — std-7)", async () => {
    tagAc(AC_37);

    const res = await app.request(
      `${nonMemberPath}/skills`,
      withApexHost({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ skillMd: SKILL_MD }),
      }),
    );
    // The strict session membership check 404s a non-member on a write route
    // before the handler runs (indistinguishable from a non-existent memex).
    expect(res.status).toBe(404);
  });
});
