import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../../db/connection.js";
import { memexes, users, usageEvents } from "../../db/schema.js";
import type { UsageEvent } from "../../db/schema.js";
import type { RequestCtx } from "../mutate.js";
import { ValidationError } from "../../types/errors.js";
import { makeTestMemex } from "../test-helpers.js";
import { reconstructSkillMd } from "./reconstruct-skill-md.js";
import { createSkill, getSkill, listSkills } from "./skills-service.js";
import {
  SKILL_USED_EVENT,
  getSkillUsageReport,
  getSkillsUsedForSpec,
} from "./skill-metering.js";

// spec-300 t-5 — Skills usage metering (dec-21). A get_skill BODY fetch emits
// exactly one `skill.used` usage event (skill, working-Spec ref, actor, channel,
// time); a list_skills appearance emits nothing. The events power the hot/cold
// report and the per-Spec inverse view. Duplicate-name rejection is enforced in
// the SERVICE (the single source for REST/UI/MCP).

const ac = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-300/acs/ac-${n}`;

const md = (name: string) =>
  reconstructSkillMd({
    name,
    description: `Test skill ${name}. Use when: metering tests run.`,
    body: `# ${name}\n\nBody.`,
  });

let memexA: string;
let memexReport: string;
let actorUserId: string;
// A unique Spec ref per run so the inverse-view assertions never collide with
// other rows (fixture isolation under parallel execution, std-37).
const SPEC_REF = `mindset-prod/memex-building-itself/specs/spec-300#${Date.now()}`;

/** The MCP-style ctx: a real actor (FK-valid) + the 'mcp' channel. */
let ctx: RequestCtx;

/** All `skill.used` rows in a memex, newest first — filtered in JS by handle. */
async function usedRows(memexId: string): Promise<UsageEvent[]> {
  return db
    .select()
    .from(usageEvents)
    .where(and(eq(usageEvents.memexId, memexId), eq(usageEvents.name, SKILL_USED_EVENT)));
}

function forHandle(rows: UsageEvent[], handle: string): UsageEvent[] {
  return rows.filter(
    (r) => (r.props as Record<string, unknown> | null)?.skill_handle === handle,
  );
}

beforeAll(async () => {
  memexA = await makeTestMemex("skl-meter-a");
  memexReport = await makeTestMemex("skl-meter-r");
  const [u] = await db
    .insert(users)
    .values({ email: `skl-meter-${Date.now()}@example.com` } as typeof users.$inferInsert)
    .returning();
  actorUserId = u!.id;
  ctx = { actorUserId, channel: "mcp" };
});

afterAll(async () => {
  // usage_events cascade on memex delete (memex_id FK onDelete: cascade).
  await db.delete(memexes).where(inArray(memexes.id, [memexA, memexReport])).catch(() => {});
  await db.delete(users).where(eq(users.id, actorUserId)).catch(() => {});
});

describe("get_skill body fetch emits one usage event; list_skills emits none", () => {
  it("writes exactly one skill.used event carrying skill, working-Spec, actor, channel, time", async () => {
    tagAc(ac(42));
    tagAc(ac(19));

    const created = await createSkill(memexA, { skillMd: md("meter-one") });
    // createSkill itself must NOT record a use (it's not a body fetch).
    expect(forHandle(await usedRows(memexA), created.handle)).toHaveLength(0);

    const before = Date.now();
    await getSkill(memexA, created.handle, ctx, { workingSpecRef: SPEC_REF });

    const rows = forHandle(await usedRows(memexA), created.handle);
    expect(rows).toHaveLength(1); // exactly one — not per-list, per body fetch
    const ev = rows[0]!;
    const props = ev.props as Record<string, unknown>;

    // WHAT — the skill (handle + ref + stable id).
    expect(props.skill_handle).toBe(created.handle);
    expect(props.skill_ref).toBe(created.ref);
    expect(typeof props.skill_id).toBe("string");
    // The working-Spec ref (the inverse-view key).
    expect(props.working_spec_ref).toBe(SPEC_REF);
    // WHO — the resolved actor.
    expect(ev.actorUserId).toBe(actorUserId);
    // HOW — the channel.
    expect(props.channel).toBe("mcp");
    // Provenance + WHEN.
    expect(ev.name).toBe(SKILL_USED_EVENT);
    expect(ev.source).toBe("backend");
    expect(ev.occurredAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it("list_skills records no usage event (a list appearance is not a use)", async () => {
    tagAc(ac(42));
    tagAc(ac(19));

    const created = await createSkill(memexA, { skillMd: md("meter-list-noop") });
    const before = (await usedRows(memexA)).length;

    await listSkills(memexA);

    const after = (await usedRows(memexA)).length;
    expect(after).toBe(before);
    expect(forHandle(await usedRows(memexA), created.handle)).toHaveLength(0);
  });
});

describe("hot/cold report + per-Spec inverse view (dec-21)", () => {
  it("ranks skills by use-count (hot → cold) and lists a Spec's pulled skills", async () => {
    tagAc(ac(18));

    const specRef = `${SPEC_REF}/inverse`;
    const hot = await createSkill(memexReport, { skillMd: md("hot-skill") });
    const cold = await createSkill(memexReport, { skillMd: md("cold-skill") });
    const never = await createSkill(memexReport, { skillMd: md("never-skill") });

    // hot pulled 3× (twice against our Spec), cold pulled once (a different Spec),
    // never pulled at all.
    await getSkill(memexReport, hot.handle, ctx, { workingSpecRef: specRef });
    await getSkill(memexReport, hot.handle, ctx, { workingSpecRef: specRef });
    await getSkill(memexReport, hot.handle, ctx);
    await getSkill(memexReport, cold.handle, ctx, { workingSpecRef: `${specRef}/other` });

    // ── Hot/cold report: every active skill, ranked most-used → least-used.
    const report = await getSkillUsageReport(memexReport);
    const rank = (h: string) => report.findIndex((r) => r.handle === h);
    const row = (h: string) => report.find((r) => r.handle === h)!;

    expect(row(hot.handle).useCount).toBe(3);
    expect(row(cold.handle).useCount).toBe(1);
    expect(row(never.handle).useCount).toBe(0);
    expect(row(hot.handle).lastUsedAt).toBeTruthy();
    expect(row(never.handle).lastUsedAt).toBeNull();
    // Ranking is descending by use-count: hot before cold before never.
    expect(rank(hot.handle)).toBeLessThan(rank(cold.handle));
    expect(rank(cold.handle)).toBeLessThan(rank(never.handle));

    // ── Inverse view: which skills a given Spec pulled. Only `hot` was pulled
    // against `specRef` (cold used a different Spec, never wasn't fetched).
    const pulled = await getSkillsUsedForSpec(memexReport, specRef);
    expect(pulled.map((s) => s.handle)).toEqual([hot.handle]);
    expect(pulled[0]!.useCount).toBe(2);
    expect(pulled.some((s) => s.handle === cold.handle)).toBe(false);
    expect(pulled.some((s) => s.handle === never.handle)).toBe(false);
  });
});

describe("createSkill duplicate-name guard (dec-14 / ac-36)", () => {
  it("rejects a second skill with the same name in the same Memex, service-level", async () => {
    tagAc(ac(36));

    await createSkill(memexA, { skillMd: md("unique-name-skill") });

    await expect(
      createSkill(memexA, { skillMd: md("unique-name-skill") }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createSkill(memexA, { skillMd: md("unique-name-skill") }),
    ).rejects.toThrow(/already exists/i);
  });
});
