// spec-122 t-5 (dec-8) — the WHO resolver.
//
//   ac-25  a free-form test_events.actor matching a user's email (or name)
//          renders that user's display name + is attributed under their user_id.
//   ac-26  a free-form actor matching no user renders verbatim, never collapsed
//          to "You" or to a wrong user (ambiguous name → verbatim too).
//   ac-27  an agent clientId resolves "<user name>'s <clientName>".
//   ac-28  no user_identities table — WHO is resolved using only existing
//          columns (users.email, users.name, mcp_sessions.client_name).
//
// TAGGED → reports to the PROD memex. Run with MEMEX_EMIT_KEY set.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { users, mcpSessions } from "../db/schema.js";
import {
  resolveTestEventActor,
  resolveTestEventActors,
  resolveAgentClientLabel,
} from "./who-resolver.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-122/acs";

const created = { users: [] as string[], sessions: [] as string[] };
const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const christineEmail = `christine-${tag}@memex.ai`;
// spec-259 dec-4: the resolver now title-cases a RESOLVED user's display name. The
// seed name is "Christine <tag>" with a lowercase tag, so the rendered display
// capitalises the tag's leading letter too (digits are unaffected by toUpperCase).
const christineDisplay = `Christine ${tag.charAt(0).toUpperCase()}${tag.slice(1)}`;
let christineId: string;
let twinAId: string;
let twinBId: string;
let sessionId: string;

beforeAll(async () => {
  const [christine] = await db
    .insert(users)
    .values({ email: christineEmail, name: `Christine ${tag}` } as typeof users.$inferInsert)
    .returning();
  christineId = christine.id;
  created.users.push(christineId);

  // Two users with the SAME name → an ambiguous name match (must NOT attribute).
  const twinName = `Twin ${tag}`;
  const [a] = await db.insert(users).values({ email: `twin-a-${tag}@memex.ai`, name: twinName } as typeof users.$inferInsert).returning();
  const [b] = await db.insert(users).values({ email: `twin-b-${tag}@memex.ai`, name: twinName } as typeof users.$inferInsert).returning();
  twinAId = a.id; twinBId = b.id;
  created.users.push(twinAId, twinBId);

  // An agent session owned by Christine, client "Claude Code".
  sessionId = `sess-${tag}`;
  await db.insert(mcpSessions).values({ sessionId, userId: christineId, clientName: "Claude Code" });
  created.sessions.push(sessionId);
});

afterAll(async () => {
  if (created.sessions.length) await db.delete(mcpSessions).where(inArray(mcpSessions.sessionId, created.sessions)).catch(() => {});
  if (created.users.length) await db.delete(users).where(inArray(users.id, created.users)).catch(() => {});
});

describe("WHO resolver [spec-122 t-5]", () => {
  // ── ac-25 ───────────────────────────────────────────────────────────────
  it("ac-25: a test_events.actor matching a user's email resolves to their name + user_id", async () => {
    tagAc(`${AC}/ac-25`);
    const r = await resolveTestEventActor(christineEmail.toUpperCase()); // case-insensitive
    expect(r.userId).toBe(christineId);
    expect(r.display).toBe(christineDisplay);
  });

  it("ac-25: a test_events.actor matching a user's (unambiguous) name resolves + unifies", async () => {
    tagAc(`${AC}/ac-25`);
    const r = await resolveTestEventActor(`Christine ${tag}`);
    expect(r.userId).toBe(christineId);
    expect(r.display).toBe(christineDisplay);
  });

  it("ac-25: the batch resolver unifies email + name hits in one pass", async () => {
    tagAc(`${AC}/ac-25`);
    const map = await resolveTestEventActors([christineEmail, `Christine ${tag}`, "CI · zzz"]);
    expect(map.get(christineEmail)?.userId).toBe(christineId);
    expect(map.get(`Christine ${tag}`)?.userId).toBe(christineId);
    expect(map.get("CI · zzz")).toEqual({ display: "CI · zzz", userId: null });
  });

  // ── ac-26 ───────────────────────────────────────────────────────────────
  it("ac-26: an actor matching no user renders verbatim, never 'You', never a user_id", async () => {
    tagAc(`${AC}/ac-26`);
    const r = await resolveTestEventActor("CI · abc123");
    expect(r).toEqual({ display: "CI · abc123", userId: null });
    expect(r.display).not.toBe("You");
  });

  it("ac-26: an AMBIGUOUS name match is treated as a miss (never the wrong user)", async () => {
    tagAc(`${AC}/ac-26`);
    const r = await resolveTestEventActor(`Twin ${tag}`);
    expect(r.userId).toBeNull(); // not twinA, not twinB — won't guess
    expect(r.display).toBe(`Twin ${tag}`);
  });

  // ── ac-27 ───────────────────────────────────────────────────────────────
  it("ac-27: an agent clientId resolves \"<user name>'s <clientName>\"", async () => {
    tagAc(`${AC}/ac-27`);
    const label = await resolveAgentClientLabel(sessionId);
    expect(label).toBe(`${christineDisplay}'s Claude Code`);
  });

  it("ac-27: an unknown clientId resolves to null (no fabricated label)", async () => {
    tagAc(`${AC}/ac-27`);
    expect(await resolveAgentClientLabel("sess-does-not-exist")).toBeNull();
  });

  // ── ac-28 ───────────────────────────────────────────────────────────────
  it("ac-28: no user_identities table exists; WHO resolves from existing columns only", async () => {
    tagAc(`${AC}/ac-28`);
    const t = await db.execute(sql`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'user_identities'
    `);
    expect((t as unknown as unknown[]).length).toBe(0);

    // And the resolver still produces correct results — proving it needs only
    // users.email / users.name / mcp_sessions.client_name.
    const byEmail = await resolveTestEventActor(christineEmail);
    expect(byEmail.userId).toBe(christineId);
    const label = await resolveAgentClientLabel(sessionId);
    expect(label).toBe(`${christineDisplay}'s Claude Code`);
  });
});
