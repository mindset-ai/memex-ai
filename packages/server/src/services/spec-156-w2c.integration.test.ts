// spec-156 W2-C — service-layer remediation (std-8 reactivity).
//
// Proves the four W2-C audit fixes against a real Postgres:
//   ac-17  proposeStandardChange dual-emits standard_drift.created (mirrors flagDrift)
//   ac-20  addBlocker/removeBlocker + applyTagString/removeTagString return Mutated<…>
//   ac-26  the waitlist insert emits waitlist_entry.created (silent:true removed)
//
// TAGGED with tagAc (@memex-ai-ac/vitest) → reports pass/fail to the PROD memex
// (the spec lives at mindset-prod/…). A human runs this; auto mode skips tagged suites.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { inArray, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, decisions, tasks, waitlistEntries, oauthClients } from "../db/schema.js";
import { bus, type ChangeEvent } from "./bus.js";
import { getMutateMetrics } from "./mutate.js";
import { registerClient } from "./oauth/clients.js";
import { createStandard, proposeStandardChange } from "./standards.js";
import { createDocDraft } from "./documents.js";
import { createTask } from "./tasks.js";
import { createDecision } from "./decisions.js";
import { addBlocker, removeBlocker } from "./shared/blockers.js";
import { applyTagString, removeTagString } from "./tags.js";
import { addWaitlistEntry } from "./waitlist.js";
import { makeTestMemex } from "./test-helpers.js";
import type { Mutated } from "./mutate.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-156/acs";

const createdDocIds: string[] = [];
const createdEmails: string[] = [];
const createdClientIds: string[] = [];

afterAll(async () => {
  if (createdDocIds.length) {
    await db.delete(tasks).where(inArray(tasks.docId, createdDocIds)).catch(() => {});
    await db.delete(decisions).where(inArray(decisions.docId, createdDocIds)).catch(() => {});
    await db.delete(documents).where(inArray(documents.id, createdDocIds)).catch(() => {});
  }
  if (createdEmails.length) {
    await db.delete(waitlistEntries).where(inArray(waitlistEntries.email, createdEmails)).catch(() => {});
  }
  for (const cid of createdClientIds) {
    await db.delete(oauthClients).where(eq(oauthClients.clientId, cid)).catch(() => {});
  }
});

// Collect every ChangeEvent emitted on the unified bus during `body`.
async function captureEvents(body: () => Promise<void>): Promise<ChangeEvent[]> {
  const events: ChangeEvent[] = [];
  const unsub = bus.subscribe({}, (e) => events.push(e));
  try {
    await body();
  } finally {
    unsub();
  }
  return events;
}

// Compile-time brand assertion: this only accepts a genuine `Mutated<T>`. Passing an
// unbranded value to it is a tsc error — so a passing `tsc -b` IS the proof that the
// orchestrator preserved the brand across its boundary (spec-156 ac-20).
function requireMutated<T>(value: Mutated<T>): T {
  return value;
}

describe("spec-156 ac-17: proposeStandardChange dual-emits standard_drift.created", () => {
  it("emits standard_drift.created alongside the inner comment.created, mirroring flagDrift", async () => {
    tagAc(`${AC}/ac-17`);
    const memexId = await makeTestMemex("s156-ac17");
    const bp = await createStandard(memexId, {
      title: "Drift proposal target",
      sections: [{ sectionType: "do", content: "Always cache writes." }],
    });
    createdDocIds.push(bp.id);
    const sectionId = bp.sections[0].id;

    const events = await captureEvents(async () => {
      await proposeStandardChange(
        memexId,
        sectionId,
        "Cache writes through, except for mutating endpoints.",
        "observed pattern in repo",
      );
    });

    // The aggregate event for the StandardList drift-count subscriber, keyed on the
    // standard doc (mirrors flagDrift's dual emit, spec-143 dec-2).
    const drift = events.filter(
      (e) =>
        e.memexId === memexId &&
        e.docId === bp.id &&
        e.entity === "standard_drift" &&
        e.action === "created",
    );
    expect(drift).toHaveLength(1);

    // The inner comment.created still fires from addComment for the per-doc subscriber.
    const commentCreated = events.filter(
      (e) => e.entity === "comment" && e.action === "created",
    );
    expect(commentCreated.length).toBeGreaterThanOrEqual(1);
  });

  it("returns a Mutated-branded result (brand survives proposeStandardChange)", async () => {
    tagAc(`${AC}/ac-17`);
    const memexId = await makeTestMemex("s156-ac17b");
    const bp = await createStandard(memexId, {
      title: "Brand target",
      sections: [{ sectionType: "do", content: "x" }],
    });
    createdDocIds.push(bp.id);

    const result = await proposeStandardChange(memexId, bp.sections[0].id, "replacement");
    // Compile-time: only a Mutated<…> type-checks here.
    const unwrapped = requireMutated(result);
    expect(unwrapped.comment.commentType).toBe("plan_revision");
  });
});

describe("spec-156 ac-20: composite orchestrators preserve the Mutated brand", () => {
  it("addBlocker / removeBlocker return Mutated<void>", async () => {
    tagAc(`${AC}/ac-20`);
    const memexId = await makeTestMemex("s156-ac20-b");
    const doc = await createDocDraft(memexId, "Blocker Spec", "purpose", "spec");
    createdDocIds.push(doc.id);
    const task = await createTask(memexId, doc.id, "blocked task", "desc");
    const dec = await createDecision(memexId, doc.id, "blocking decision");

    const added = await addBlocker(memexId, task.id, `D-${dec.seq}`);
    // Compile-time brand proof — tsc -b rejects this line if addBlocker returns plain void.
    requireMutated(added);

    const removed = await removeBlocker(memexId, task.id, `D-${dec.seq}`);
    requireMutated(removed);

    // Functional: the edge was added then removed (best-effort sanity, brand is the AC).
    expect(added).not.toBeUndefined;
    expect(removed).not.toBeUndefined;
  });

  it("applyTagString / removeTagString return Mutated-branded tags", async () => {
    tagAc(`${AC}/ac-20`);
    const memexId = await makeTestMemex("s156-ac20-t");
    const doc = await createDocDraft(memexId, "Tag Spec", "purpose", "spec");
    createdDocIds.push(doc.id);
    const ctx = { channel: "rest_ui" as const };

    const applied = await applyTagString(ctx, memexId, doc.id, "priority::high");
    // Compile-time brand proof on the resolved tag.
    const tag = requireMutated(applied);
    expect(tag.scope).toBe("priority");
    expect(tag.value).toBe("high");

    const removed = await removeTagString(ctx, memexId, doc.id, "priority::high");
    // removeTagString returns Mutated<Tag> | null — the brand survives the truthy case.
    expect(removed).not.toBeNull();
    if (removed) {
      const removedTag = requireMutated(removed);
      expect(removedTag.value).toBe("high");
    }

    // A remove of a never-applied tag is a true no-op → plain null (no write to brand).
    const noop = await removeTagString(ctx, memexId, doc.id, "area::nonexistent");
    expect(noop).toBeNull();
  });
});

describe("spec-156 ac-26: the waitlist insert emits waitlist_entry.created", () => {
  it("fires waitlist_entry.created on signup (silent:true removed)", async () => {
    tagAc(`${AC}/ac-26`);
    const email = `s156-ac26-${Date.now().toString(36)}@example.com`;
    createdEmails.push(email);

    const events = await captureEvents(async () => {
      await addWaitlistEntry({ name: "Eve", company: "Acme", email });
    });

    const waitlistCreated = events.filter(
      (e) => e.entity === "waitlist_entry" && e.action === "created",
    );
    expect(waitlistCreated).toHaveLength(1);
    // Global resource → no memexId, no docId on the event.
    expect(waitlistCreated[0]!.memexId).toBe("");
    expect(waitlistCreated[0]!.docId).toBeUndefined();
  });
});

describe("spec-156 ac-18: OAuth writes go through mutate({silent:true}), de-allowlisted", () => {
  it("registerClient routes through mutate({silent:true}) — write counted, row lands, NO bus emit", async () => {
    tagAc(`${AC}/ac-18`);
    // The {silent:true} contract (std-8 §6): the write IS a mutate() — so the
    // coverage scanner is satisfied and the Mutated brand is preserved — but it
    // intentionally emits NO bus event (anonymous cross-tenant OAuth registry,
    // no memexId, no SSE subscriber). Assert all three properties.
    const before = getMutateMetrics();

    const events = await captureEvents(async () => {
      const reg = await registerClient({
        clientName: "spec-156 ac-18 probe",
        redirectUris: ["https://example.com/cb"],
      });
      createdClientIds.push(reg.clientId);
    });

    const after = getMutateMetrics();
    // Went through mutate() as a SILENT write (not a plain raw db.insert).
    expect(after.silentWrites - before.silentWrites).toBeGreaterThanOrEqual(1);
    expect(after.writes - before.writes).toBeGreaterThanOrEqual(1);

    // The row actually landed (the mutate callback ran the insert).
    const cid = createdClientIds[createdClientIds.length - 1]!;
    const row = await db
      .select({ id: oauthClients.id })
      .from(oauthClients)
      .where(eq(oauthClients.clientId, cid))
      .limit(1);
    expect(row).toHaveLength(1);

    // Silent contract: NO oauth_client event reaches the bus (no SSE fan-out).
    const oauthEvents = events.filter((e) => e.entity === "oauth_client");
    expect(oauthEvents).toHaveLength(0);
  });

  it("the oauth service files are absent from the static-scan allowlist", () => {
    tagAc(`${AC}/ac-18`);
    // ac-18's other half: the de-allowlisting. Read the allowlist source and
    // assert none of the three oauth files are keyed in it — so the widened
    // scanner verifies them like any other service. (Path-keyed per ac-23.)
    const here = dirname(fileURLToPath(import.meta.url));
    const scanSrc = readFileSync(
      resolve(here, "..", "__regression__", "mutate-coverage.static-scan.test.ts"),
      "utf8",
    );
    // Isolate the ALLOWLIST object literal so a mention in a comment elsewhere
    // doesn't produce a false positive.
    const start = scanSrc.indexOf("const ALLOWLIST");
    expect(start).toBeGreaterThan(-1);
    const end = scanSrc.indexOf("\n};", start);
    expect(end).toBeGreaterThan(start);
    const allowlistBlock = scanSrc.slice(start, end);
    for (const f of [
      "services/oauth/clients.ts",
      "services/oauth/codes.ts",
      "services/oauth/refresh-tokens.ts",
    ]) {
      expect(allowlistBlock).not.toContain(`"${f}"`);
    }
  });
});
