// spec-453 t-5 — the "Connect with people" Day-12 pass, unit level: the Day-12 + go-live
// window (a pure function) and the pass's flag-gate / dedup / independence, with the
// DB-touching deps (candidate select, comms dedup, send chokepoint, flag) mocked. The
// real builder runs for real (it's pure). Real-DB behaviour is the integration test's job.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-453/acs/ac-${n}`;

// ── mock the DB-touching collaborators ──────────────────────────────────────
const selectActivationCandidates = vi.fn();
const hasComm = vi.fn();
const sendLifecycleEmail = vi.fn();
const activationEmailsEnabled = vi.fn();

vi.mock("./activation-drip.js", () => ({
  selectActivationCandidates: (...a: unknown[]) => selectActivationCandidates(...a),
}));
vi.mock("../comms-log.js", () => ({ hasComm: (...a: unknown[]) => hasComm(...a) }));
vi.mock("./lifecycle-send.js", () => ({ sendLifecycleEmail: (...a: unknown[]) => sendLifecycleEmail(...a) }));
vi.mock("./activation-flag.js", () => ({ activationEmailsEnabled: () => activationEmailsEnabled() }));

import {
  CONNECT_PEOPLE_COMMS_KEY,
  CONNECT_PEOPLE_DWELL_DAYS,
  connectPeopleEligible,
  runConnectPeoplePass,
} from "./connect-people.js";
import type { Db } from "../../db/connection.js";

const conn = {} as unknown as Db;
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-07-01T00:00:00Z");
// Go-live well in the past so the Day-12 gate and the back-catalog floor can be exercised
// independently by placing signups on either side of (GO_LIVE − 12d).
const GO_LIVE = new Date("2026-06-01T00:00:00Z");
const daysBefore = (ref: Date, d: number) => new Date(ref.getTime() - d * DAY);

interface Cand {
  id: string;
  email: string | null;
  name: string | null;
  createdAt?: Date;
}
const candidate = (over: Partial<Cand> & { id: string }): Cand => ({
  email: `${over.id}@example.test`,
  name: null,
  createdAt: daysBefore(NOW, 20), // comfortably past Day-12 and after go-live by default
  ...over,
});

beforeEach(() => {
  hasComm.mockResolvedValue(false);
  sendLifecycleEmail.mockResolvedValue(true);
  activationEmailsEnabled.mockReturnValue(true);
  selectActivationCandidates.mockResolvedValue([]);
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("connectPeopleEligible — the Day-12 window", () => {
  it("fires at 12 days since signup, not at 11 (ac-6)", () => {
    tagAc(AC(6));
    // Signups both sit after (GO_LIVE − 12d), so only the Day-12 gate is in play.
    expect(connectPeopleEligible(daysBefore(NOW, 11), NOW, GO_LIVE)).toBe(false);
    expect(connectPeopleEligible(daysBefore(NOW, 12), NOW, GO_LIVE)).toBe(true);
  });

  it("exposes Day-12 as the offset", () => {
    expect(CONNECT_PEOPLE_DWELL_DAYS).toBe(12);
  });
});

describe("connectPeopleEligible — the go-live back-catalog floor (ac-19)", () => {
  // `now` far in the future so Day-12 is always reached; the floor is the only gate.
  const LATE = new Date("2026-12-01T00:00:00Z");

  it("excludes signups whose Day-12 fell before go-live", () => {
    tagAc(AC(19));
    // Crossed Day-12 the day BEFORE go-live → excluded.
    expect(connectPeopleEligible(daysBefore(GO_LIVE, 13), LATE, GO_LIVE)).toBe(false);
    // Crossed Day-12 the day AFTER go-live → included.
    expect(connectPeopleEligible(daysBefore(GO_LIVE, 11), LATE, GO_LIVE)).toBe(true);
  });
});

describe("runConnectPeoplePass", () => {
  it("sends the Connect email once to an eligible verified user, exclusively via sendLifecycleEmail (ac-6, ac-10)", async () => {
    tagAc(AC(6));
    tagAc(AC(10)); // Connect's half of "both emails send exclusively through sendLifecycleEmail"
    selectActivationCandidates.mockResolvedValue([candidate({ id: "u1", name: "Ada Lovelace" })]);

    const summary = await runConnectPeoplePass(GO_LIVE, NOW, conn);

    expect(summary).toMatchObject({ evaluated: 1, sent: 1, errors: 0 });
    expect(sendLifecycleEmail).toHaveBeenCalledTimes(1);
    const [user, message] = sendLifecycleEmail.mock.calls[0];
    expect(user).toEqual({ id: "u1", email: "u1@example.test" });
    expect(message.commsType).toBe(CONNECT_PEOPLE_COMMS_KEY);
  });

  it("skips candidates that have not yet reached Day-12 (ac-6)", async () => {
    tagAc(AC(6));
    selectActivationCandidates.mockResolvedValue([
      candidate({ id: "tooNew", createdAt: daysBefore(NOW, 5) }),
      candidate({ id: "ready", createdAt: daysBefore(NOW, 20) }),
    ]);

    const summary = await runConnectPeoplePass(GO_LIVE, NOW, conn);

    expect(summary.sent).toBe(1);
    expect(sendLifecycleEmail).toHaveBeenCalledTimes(1);
    expect(sendLifecycleEmail.mock.calls[0][0].id).toBe("ready");
  });

  it("dedups on the stable comms key — an already-sent user is skipped (ac-7, ac-11)", async () => {
    tagAc(AC(7));
    tagAc(AC(11)); // Connect's half: dedup on its own stable comms_log.type key via hasComm
    hasComm.mockResolvedValue(true);
    selectActivationCandidates.mockResolvedValue([candidate({ id: "u1" })]);

    const summary = await runConnectPeoplePass(GO_LIVE, NOW, conn);

    expect(summary.sent).toBe(0);
    expect(hasComm).toHaveBeenCalledWith("u1", CONNECT_PEOPLE_COMMS_KEY, conn);
    expect(sendLifecycleEmail).not.toHaveBeenCalled();
  });

  it("does no scan and no send while the flag is off (ac-17)", async () => {
    tagAc(AC(17));
    activationEmailsEnabled.mockReturnValue(false);
    selectActivationCandidates.mockResolvedValue([candidate({ id: "u1" })]);

    const summary = await runConnectPeoplePass(GO_LIVE, NOW, conn);

    expect(summary).toMatchObject({ evaluated: 0, sent: 0 });
    expect(selectActivationCandidates).not.toHaveBeenCalled();
    expect(sendLifecycleEmail).not.toHaveBeenCalled();
  });

  it("sends independently of the spec-427 cohort ladder — a user with a cohort email still gets Connect (ac-17)", async () => {
    tagAc(AC(17));
    // hasComm returns true only for a spec-427 cohort key, never the Connect key.
    hasComm.mockImplementation((_id: string, type: string) =>
      Promise.resolve(type === "activation.connected_inactive"),
    );
    selectActivationCandidates.mockResolvedValue([candidate({ id: "both" })]);

    const summary = await runConnectPeoplePass(GO_LIVE, NOW, conn);

    expect(summary.sent).toBe(1);
    expect(sendLifecycleEmail).toHaveBeenCalledTimes(1);
  });

  it("does not blast the pre-go-live back-catalog on the first pass (ac-19)", async () => {
    tagAc(AC(19));
    // A seeded back-catalog: all past Day-12, but all crossed it BEFORE go-live.
    selectActivationCandidates.mockResolvedValue([
      candidate({ id: "old1", createdAt: daysBefore(GO_LIVE, 30) }),
      candidate({ id: "old2", createdAt: daysBefore(GO_LIVE, 100) }),
      candidate({ id: "old3", createdAt: daysBefore(GO_LIVE, 13) }),
    ]);

    const summary = await runConnectPeoplePass(GO_LIVE, NOW, conn);

    expect(summary).toMatchObject({ evaluated: 0, sent: 0 });
    expect(sendLifecycleEmail).not.toHaveBeenCalled();
  });

  it("isolates a failing send — one throw does not abort the run", async () => {
    selectActivationCandidates.mockResolvedValue([
      candidate({ id: "ok1" }),
      candidate({ id: "boom" }),
      candidate({ id: "ok2" }),
    ]);
    sendLifecycleEmail.mockImplementation((user: { id: string }) => {
      if (user.id === "boom") throw new Error("postmark 500");
      return Promise.resolve(true);
    });

    const summary = await runConnectPeoplePass(GO_LIVE, NOW, conn);

    expect(summary).toMatchObject({ evaluated: 3, sent: 2, errors: 1 });
  });
});
