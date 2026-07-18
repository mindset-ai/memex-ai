// spec-427 t-7 — the daily drip evaluator, unit level: the priority ladder, dwell
// timers, and comms_log dedup, with the DB-touching deps (cohort eval, comms read,
// send chokepoint, flag) mocked. Real-DB behaviour is covered in the .integration test.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-427/acs/ac-${n}`;
// spec-480 amended the win-back orchestration (dec-9/dec-10): signed_in_dormant → the
// video win-back keyed activation.signed_in_dormant; connected_inactive deferred (not sent in v1).
const AC480 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-480/acs/ac-${n}`;
// spec-487 revived connected_inactive (dec-1): it now sends its own Day-2 "create a spec" email.
const AC487 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-487/acs/ac-${n}`;

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
  it("the win-back fires at ~3 days in signed-in-dormant, not before (spec-480 ac-12)", () => {
    tagAc(AC(2));
    // spec-480 dec-7: 3 days (anchored to email_verified_at) is now the SOLE win-back dwell.
    tagAc(AC480(12));
    expect(dwellElapsed("signed_in_dormant", daysAgo(2), NOW)).toBe(false);
    expect(dwellElapsed("signed_in_dormant", daysAgo(3), NOW)).toBe(true);
  });
});

describe("sendActivationEmailForUser — ladder + dwell + dedup", () => {
  it("connected-inactive past dwell → sends its Day-2 email, keyed activation.connected_inactive (spec-487 ac-5)", async () => {
    tagAc(AC487(5));
    evaluateActivationState.mockResolvedValue({ cohort: "connected_inactive", enteredAt: daysAgo(3) });
    const out = await sendActivationEmailForUser(USER, NOW, fakeConn);
    // spec-487 dec-1: connected_inactive is REVIVED — it sends its own "create a spec" email.
    expect(out).toMatchObject({ cohort: "connected_inactive", sent: true, reason: "sent" });
    const [, msg] = sendLifecycleEmail.mock.calls[0]!;
    expect(msg.commsType).toBe("activation.connected_inactive");
    expect(msg.commsType).toBe(ACTIVATION_COMMS_KEY.connected_inactive);
  });

  it("signed-in-dormant past dwell → sends the win-back, keyed activation.signed_in_dormant (ac-2, spec-480 ac-13/ac-14)", async () => {
    tagAc(AC(2));
    tagAc(AC480(13));
    tagAc(AC480(14));
    evaluateActivationState.mockResolvedValue({ cohort: "signed_in_dormant", enteredAt: daysAgo(4) });
    const out = await sendActivationEmailForUser(USER, NOW);
    expect(out).toMatchObject({ cohort: "signed_in_dormant", sent: true, reason: "sent" });
    const [, msg] = sendLifecycleEmail.mock.calls[0]!;
    // spec-480 dec-8: the win-back template, keyed activation.signed_in_dormant; single "Connect your agent" CTA.
    expect(msg.commsType).toBe("activation.signed_in_dormant");
    expect(msg.commsType).toBe(ACTIVATION_COMMS_KEY.signed_in_dormant);
    expect(msg.html).toContain(">Connect your agent</a>");
  });

  it("dwell not yet elapsed → no send (spec-480 ac-12: single 3-day win-back dwell)", async () => {
    tagAc(AC480(12));
    // signed_in_dormant is the sole v1 cohort; its dwell is 3 days (email_verified_at).
    evaluateActivationState.mockResolvedValue({ cohort: "signed_in_dormant", enteredAt: daysAgo(2) });
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

  it("already sent the win-back → deduped, no re-send (ac-3, spec-480 ac-13)", async () => {
    tagAc(AC(3));
    tagAc(AC480(13));
    evaluateActivationState.mockResolvedValue({ cohort: "signed_in_dormant", enteredAt: daysAgo(4) });
    hasComm.mockResolvedValue(true);
    const out = await sendActivationEmailForUser(USER, NOW);
    expect(out.reason).toBe("already_sent");
    expect(sendLifecycleEmail).not.toHaveBeenCalled();
  });

  it("dedup counts the stable comms KEY (activation.signed_in_dormant), never the subject line (ac-14, spec-480 ac-13)", async () => {
    tagAc(AC(14));
    tagAc(AC480(13));
    evaluateActivationState.mockResolvedValue({ cohort: "signed_in_dormant", enteredAt: daysAgo(4) });
    await sendActivationEmailForUser(USER, NOW);
    // The dedup read is keyed on the stable win-back key `activation.signed_in_dormant` (dec-8),
    // NOT the human subject line "You signed up, then vanished" (which dedup never sees).
    expect(hasComm).toHaveBeenCalledWith(USER.id, "activation.signed_in_dormant", expect.anything());
    const dedupKeys = hasComm.mock.calls.map((c) => c[1] as string);
    expect(dedupKeys).not.toContain("You signed up, then vanished");
  });

  it("live re-eval rolls a user into connected-inactive → sends its Day-2 email (ac-4, spec-487 ac-5)", async () => {
    tagAc(AC(4));
    tagAc(AC487(5));
    // Live re-eval (ac-4): a user who has since connected but made no spec is now
    // connected_inactive — and since spec-487 revived it, gets its "create a spec" email.
    evaluateActivationState.mockResolvedValue({ cohort: "connected_inactive", enteredAt: daysAgo(3) });
    hasComm.mockResolvedValue(false);
    const out = await sendActivationEmailForUser(USER, NOW, fakeConn);
    expect(out).toMatchObject({ cohort: "connected_inactive", sent: true, reason: "sent" });
    expect(sendLifecycleEmail).toHaveBeenCalledTimes(1);
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
