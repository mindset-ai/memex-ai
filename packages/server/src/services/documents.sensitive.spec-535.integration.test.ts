// spec-535 t-2 — the sensitivity flag's write path.
//
// Proves:
//   ac-7  no free-text field reaches any surface — the service signatures accept
//         no reason argument
//   ac-8  the write goes through mutate() on an explicit RequestCtx and stamps
//         WHO (id + denormalised name) and HOW (channel); a write arriving with
//         NO channel is surfaced as a visible defect — counted and logged loudly
//         — rather than coerced to a silent 'server' default, and it still
//         succeeds, because attribution must never break a write
//   ac-9  clearing nulls the whole provenance triple, so an unflagged Spec keeps
//         no residue of having once been flagged
//
// The missing-channel case deserves a word: it does NOT throw, and that is the
// house contract, not a weakening of it. `services/actor.ts` states it directly
// ("Attribution must NEVER break a write"), and spec-122 ac-21 implements the
// loud half in `flagAttributionDefect` — a counter plus a log that names the
// offending call site. A service that threw here would contradict both. What
// this test pins is that the defect is VISIBLE: silence is the failure mode
// this Spec's sibling defect (spec-501) is open on.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { documents } from "../db/schema.js";
import { createDocDraft, setSensitive, clearSensitive } from "./documents.js";
import { upsertUserByEmail } from "./users.js";
import { makeTestMemex } from "./test-helpers.js";
import { bus, type ChangeEvent } from "./bus.js";
import {
  getUnattributedMutationCount,
  _resetUnattributedMutationCount,
  startActivityLogSink,
  _stopActivityLogSink,
} from "./activity-log.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-535/acs/ac-${n}`;

describe("spec-535 t-2: the sensitivity write path", () => {
  let memexId: string;
  let actorId: string;
  const createdDocIds: string[] = [];

  beforeAll(async () => {
    memexId = await makeTestMemex("sens");
    const actor = await upsertUserByEmail("spec535-flagger@example.com");
    actorId = actor.id;
    // The attribution-defect check lives in the activity-log sink, which only
    // `index.ts` starts in a running server. Without it the missing-channel
    // path below would silently pass by never being exercised at all — exactly
    // the "green suite proves nothing" failure this Spec is about. Start it
    // here and stop it in afterAll (std-37: restore what you stubbed).
    startActivityLogSink();
  });

  afterAll(async () => {
    _stopActivityLogSink();
    for (const id of createdDocIds) await db.delete(documents).where(eq(documents.id, id));
  });

  /** The sink consumes bus events asynchronously — poll rather than assume (std-37). */
  async function waitFor(predicate: () => boolean, ms = 2000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!predicate() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  async function makeDoc(title: string): Promise<string> {
    const doc = await createDocDraft(memexId, title, "purpose", "spec");
    createdDocIds.push(doc.id);
    return doc.id;
  }

  async function captureEvents(body: () => Promise<void>): Promise<ChangeEvent[]> {
    const events: ChangeEvent[] = [];
    const unsub = bus.subscribe({ memexId }, (e) => events.push(e));
    try {
      await body();
    } finally {
      unsub();
    }
    return events;
  }

  it("ac-8: stamps WHO as id + denormalised name, and emits on the bus with the channel", async () => {
    tagAc(AC(8));
    const docId = await makeDoc("Sensitive Stamp Spec");

    const events = await captureEvents(async () => {
      await setSensitive(memexId, docId, { actorUserId: actorId, channel: "rest_ui" });
    });

    const [row] = await db.select().from(documents).where(eq(documents.id, docId));
    expect(row.sensitive).toBe(true);
    expect(row.sensitiveByUserId).toBe(actorId);
    // Denormalised at write (std-32): a later rename must not rewrite history,
    // so the name is a snapshot on the row, never a read-time join.
    expect(row.sensitiveByName).toBeTruthy();

    const mine = events.filter((e) => e.docId === docId && e.entity === "document");
    expect(mine.map((e) => e.action)).toContain("updated");
    expect(mine.every((e) => e.channel === "rest_ui")).toBe(true);
  });

  it("ac-8: a write with no channel is counted as a visible defect, and still succeeds", async () => {
    tagAc(AC(8));
    const docId = await makeDoc("Sensitive No Channel Spec");

    _resetUnattributedMutationCount();
    // Deliberately omits `channel` — the shape of the spec-501 defect class.
    await setSensitive(memexId, docId, { actorUserId: actorId });

    // Loud: the sink counted it rather than quietly coercing it to 'server'.
    await waitFor(() => getUnattributedMutationCount() > 0);
    expect(getUnattributedMutationCount()).toBeGreaterThan(0);

    // And non-fatal: the write landed. Attribution never breaks a write.
    const [row] = await db.select().from(documents).where(eq(documents.id, docId));
    expect(row.sensitive).toBe(true);
  });

  it("ac-9: clearing nulls the flag and the whole provenance pair", async () => {
    tagAc(AC(9));
    const docId = await makeDoc("Sensitive Clear Spec");

    await setSensitive(memexId, docId, { actorUserId: actorId, channel: "rest_ui" });
    const [flagged] = await db.select().from(documents).where(eq(documents.id, docId));
    expect(flagged.sensitive).toBe(true);
    expect(flagged.sensitiveByUserId).toBe(actorId);

    await clearSensitive(memexId, docId, { actorUserId: actorId, channel: "rest_ui" });

    const [cleared] = await db.select().from(documents).where(eq(documents.id, docId));
    expect(cleared.sensitive).toBe(false);
    expect(cleared.sensitiveByUserId).toBeNull();
    expect(cleared.sensitiveByName).toBeNull();
  });

  it("ac-8: re-flagging moves the contact to the most recent flagger", async () => {
    tagAc(AC(8));
    const docId = await makeDoc("Sensitive Refag Spec");
    const second = await upsertUserByEmail("spec535-second-flagger@example.com");

    await setSensitive(memexId, docId, { actorUserId: actorId, channel: "rest_ui" });
    await setSensitive(memexId, docId, { actorUserId: second.id, channel: "mcp" });

    const [row] = await db.select().from(documents).where(eq(documents.id, docId));
    expect(row.sensitiveByUserId).toBe(second.id);
  });

  it("ac-7: neither service function accepts a reason or any free-text argument", () => {
    tagAc(AC(7));
    // A type-level absence is invisible at runtime, so this is a source guard.
    // dec-1 closed the free-text door deliberately (this Memex is public
    // read-only; a "why is this dangerous" field is a leak surface per std-31).
    // A future edit re-opening it should fail here, loudly, with the reason.
    const src = readFileSync(join(__dirname, "documents.ts"), "utf-8");
    const start = src.indexOf("export async function setSensitive");
    const end = src.indexOf("export async function clearSensitive");
    expect(start, "setSensitive not found in documents.ts").toBeGreaterThan(-1);
    expect(end, "clearSensitive not found in documents.ts").toBeGreaterThan(start);

    // The two signatures, from `setSensitive` to the end of `clearSensitive`'s
    // parameter list — no reason/note/comment/description parameter in either.
    const clearEnd = src.indexOf("): Promise", end);
    const signatures = src.slice(start, clearEnd);
    expect(signatures).not.toMatch(/\breason\b\s*[?:]/i);
    expect(signatures).not.toMatch(/\bnote\b\s*[?:]/i);
    expect(signatures).not.toMatch(/\bdescription\b\s*[?:]/i);
  });
});
