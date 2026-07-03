// spec-427 t-7 — the daily drip evaluator, unit level: the priority ladder, dwell
// timers, and comms_log dedup, with the DB-touching deps (cohort eval, comms read,
// send chokepoint, flag) mocked. Real-DB behaviour is covered in the .integration test.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-427/acs/ac-${n}`;

// ── mock the DB-touching collaborators ──────────────────────────────────────
const evaluateActivationState = vi.fn();
const hasComm = vi.fn();
const sendLifecycleEmail = vi.fn();
const activationEmailsEnabled = vi.fn();

vi.mock("../activation-cohort.js", () => ({
  evaluateActivationState: (...a: unknown[]) => evaluateActivationState(...a),
}));
vi.mock("../comms-log.js", () => ({ hasComm: (...a: unknown[]) => hasComm(...a) }));
vi.mock("./lifecycle-send.js", () => ({ sendLifecycleEmail: (...a: unknown[]) => sendLifecycleEmail(...a) }));
vi.mock("./activation-flag.js", () => ({ activationEmailsEnabled: () => activationEmailsEnabled() }));

import {
  ACTIVATION_COMMS_KEY,
  dwellElapsed,
  runActivationDrip,
  sendActivationEmailForUser,
  type CandidateUser,
} from "./activation-drip.js";
import type { Db } from "../../db/connection.js";

// A minimal chainable stand-in for the personal-Memex-path query (the only DB touch in
// the connected-inactive send path). The real query is covered in the .integration test.
const fakeConn = {
  select: () => ({
    from: () => ({
      innerJoin: () => ({
        where: () => ({ limit: async () => [{ ns: "ada", mx: "personal" }] }),
      }),
    }),
  }),
} as unknown as Db;

const USER: CandidateUser = { id: "u1", email: "u1@example.test", name: "Ada Lovelace" };
const NOW = new Date("2026-06-20T00:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);
const savedEnv = { ...process.env };

beforeEach(() => {
  hasComm.mockResolvedValue(false);
  sendLifecycleEmail.mockResolvedValue(true);
  activationEmailsEnabled.mockReturnValue(true);
  process.env.APP_BASE_URL = "https://int.memex.ai";
});
afterEach(() => {
  vi.clearAllMocks();
  process.env = { ...savedEnv };
});

describe("dwellElapsed", () => {
  it("Email 1 fires at ~2 days in connected-inactive, not before", () => {
    tagAc(AC(1));
    expect(dwellElapsed("connected_inactive", daysAgo(1), NOW)).toBe(false);
    expect(dwellElapsed("connected_inactive", daysAgo(2), NOW)).toBe(true);
  });
  it("Email 2 fires at ~3 days in signed-in-dormant, not before", () => {
    tagAc(AC(2));
    expect(dwellElapsed("signed_in_dormant", daysAgo(2), NOW)).toBe(false);
    expect(dwellElapsed("signed_in_dormant", daysAgo(3), NOW)).toBe(true);
  });
});

describe("sendActivationEmailForUser — ladder + dwell + dedup", () => {
  it("connected-inactive past dwell → sends Email 1 with the create-spec modal deep-link (ac-1)", async () => {
    tagAc(AC(1));
    evaluateActivationState.mockResolvedValue({ cohort: "connected_inactive", enteredAt: daysAgo(3) });
    const out = await sendActivationEmailForUser(USER, NOW, fakeConn);
    expect(out).toMatchObject({ cohort: "connected_inactive", sent: true, reason: "sent" });
    expect(sendLifecycleEmail).toHaveBeenCalledTimes(1);
    const [, msg] = sendLifecycleEmail.mock.calls[0]!;
    expect(msg.commsType).toBe(ACTIVATION_COMMS_KEY.connected_inactive);
    // Q1: the "Create a spec" CTA deep-links to the new-spec modal (?new=1).
    expect(msg.html).toContain("?new=1");
    expect(msg.text).toContain("Hi Ada,"); // first-name greeting
  });

  it("signed-in-dormant past dwell → sends Email 2 (ac-2)", async () => {
    tagAc(AC(2));
    evaluateActivationState.mockResolvedValue({ cohort: "signed_in_dormant", enteredAt: daysAgo(4) });
    const out = await sendActivationEmailForUser(USER, NOW);
    expect(out).toMatchObject({ cohort: "signed_in_dormant", sent: true, reason: "sent" });
    const [, msg] = sendLifecycleEmail.mock.calls[0]!;
    expect(msg.commsType).toBe(ACTIVATION_COMMS_KEY.signed_in_dormant);
  });

  it("dwell not yet elapsed → no send (ac-1)", async () => {
    tagAc(AC(1));
    evaluateActivationState.mockResolvedValue({ cohort: "connected_inactive", enteredAt: daysAgo(1) });
    const out = await sendActivationEmailForUser(USER, NOW);
    expect(out.reason).toBe("dwell_pending");
    expect(sendLifecycleEmail).not.toHaveBeenCalled();
  });

  it("no cohort (activated / ineligible) → no send", async () => {
    evaluateActivationState.mockResolvedValue({ cohort: null, enteredAt: null });
    const out = await sendActivationEmailForUser(USER, NOW);
    expect(out.reason).toBe("no_cohort");
    expect(sendLifecycleEmail).not.toHaveBeenCalled();
  });

  it("already sent this cohort's email → deduped, no re-send (ac-3)", async () => {
    tagAc(AC(3));
    evaluateActivationState.mockResolvedValue({ cohort: "connected_inactive", enteredAt: daysAgo(3) });
    hasComm.mockResolvedValue(true);
    const out = await sendActivationEmailForUser(USER, NOW);
    expect(out.reason).toBe("already_sent");
    expect(sendLifecycleEmail).not.toHaveBeenCalled();
  });

  it("dedup counts the stable comms KEY, never the subject line (ac-14)", async () => {
    tagAc(AC(14));
    evaluateActivationState.mockResolvedValue({ cohort: "connected_inactive", enteredAt: daysAgo(3) });
    await sendActivationEmailForUser(USER, NOW, fakeConn);
    // The dedup read is keyed on the stable template key for the cohort — the machine
    // key `activation.connected_inactive`, NOT the human subject line "Memex is
    // connected. Here's what to do next." (which the dedup never sees).
    expect(hasComm).toHaveBeenCalledWith(USER.id, "activation.connected_inactive", expect.anything());
    const dedupKeys = hasComm.mock.calls.map((c) => c[1] as string);
    expect(dedupKeys).not.toContain("Memex is connected. Here's what to do next.");
  });

  it("state is re-evaluated live: a user who already got Email 2 then connects rolls into Email 1 (ac-4)", async () => {
    tagAc(AC(4));
    // Live cohort is now connected-inactive; they carry the signed_in_dormant key from
    // an earlier send, but NOT the connected_inactive key → Email 1 must still send.
    evaluateActivationState.mockResolvedValue({ cohort: "connected_inactive", enteredAt: daysAgo(3) });
    hasComm.mockImplementation(async (_id: string, key: string) => key === ACTIVATION_COMMS_KEY.signed_in_dormant);
    const out = await sendActivationEmailForUser(USER, NOW, fakeConn);
    expect(out).toMatchObject({ cohort: "connected_inactive", sent: true });
    expect(hasComm).toHaveBeenCalledWith(USER.id, ACTIVATION_COMMS_KEY.connected_inactive, expect.anything());
  });

  it("a user with no email is skipped", async () => {
    const out = await sendActivationEmailForUser({ ...USER, email: null }, NOW);
    expect(out.reason).toBe("no_email");
    expect(evaluateActivationState).not.toHaveBeenCalled();
  });
});

describe("runActivationDrip — batch", () => {
  it("evaluates at most one email per user per run; one bad send never aborts the run (ac-3)", async () => {
    tagAc(AC(3));
    const users: CandidateUser[] = [
      { id: "ok1", email: "ok1@example.test", name: null },
      { id: "boom", email: "boom@example.test", name: null },
      { id: "ok2", email: "ok2@example.test", name: null },
    ];
    evaluateActivationState.mockResolvedValue({ cohort: "signed_in_dormant", enteredAt: daysAgo(5) });
    sendLifecycleEmail.mockImplementation(async (u: { id: string }) => {
      if (u.id === "boom") throw new Error("Postmark 500");
      return true;
    });
    const summary = await runActivationDrip(NOW, undefined, users);
    expect(summary.evaluated).toBe(3);
    expect(summary.sent).toBe(2); // ok1 + ok2 despite boom throwing
    expect(summary.errors).toBe(1);
    expect(summary.byCohort.signed_in_dormant).toBe(2);
  });

  it("does nothing when ACTIVATION_EMAILS_ENABLED is off — no scan, no send (ac-3)", async () => {
    tagAc(AC(3));
    activationEmailsEnabled.mockReturnValue(false);
    const summary = await runActivationDrip(NOW, undefined, [USER]);
    expect(summary).toMatchObject({ evaluated: 0, sent: 0 });
    expect(evaluateActivationState).not.toHaveBeenCalled();
    expect(sendLifecycleEmail).not.toHaveBeenCalled();
  });
});
