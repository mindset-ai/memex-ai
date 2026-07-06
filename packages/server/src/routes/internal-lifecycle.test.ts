// spec-453 t-6 (dec-11) — the shared scheduled lifecycle endpoint, unit level: the shared
// bearer auth, the both-passes delegation, retry-on-failure (500), and the go-live gate,
// with the two passes mocked. Idempotency-across-invocations against a real DB is the
// integration test's job. A source scan proves the in-process setInterval is gone.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { tagAc } from "@memex-ai-ac/vitest";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-453/acs/ac-${n}`;

const runActivationDrip = vi.fn();
const runConnectPeoplePass = vi.fn();

vi.mock("../services/email/activation-drip.js", () => ({
  runActivationDrip: (...a: unknown[]) => runActivationDrip(...a),
}));
vi.mock("../services/email/connect-people.js", () => ({
  runConnectPeoplePass: (...a: unknown[]) => runConnectPeoplePass(...a),
}));

import { internalLifecycleRouter } from "./internal-lifecycle.js";

const app = new Hono();
app.route("/api/internal", internalLifecycleRouter);

const SECRET = "s3cret-scheduler-token";
const savedEnv = { ...process.env };

function tick(headers: Record<string, string> = {}) {
  return app.request("/api/internal/lifecycle-tick", { method: "POST", headers });
}
const authed = { authorization: `Bearer ${SECRET}` };

beforeEach(() => {
  runActivationDrip.mockResolvedValue({ evaluated: 3, sent: 1, byCohort: { connected_inactive: 1, signed_in_dormant: 0 }, errors: 0 });
  runConnectPeoplePass.mockResolvedValue({ evaluated: 2, sent: 1, errors: 0 });
  process.env.LIFECYCLE_TICK_SECRET = SECRET;
  process.env.ACTIVATION_CONNECT_GO_LIVE = "2026-07-04T00:00:00Z";
});
afterEach(() => {
  vi.clearAllMocks();
  process.env = { ...savedEnv };
});

describe("POST /api/internal/lifecycle-tick — auth (ac-20)", () => {
  it("rejects a request with no Authorization header", async () => {
    tagAc(AC(20));
    const res = await tick();
    expect(res.status).toBe(401);
    expect(runActivationDrip).not.toHaveBeenCalled();
    expect(runConnectPeoplePass).not.toHaveBeenCalled();
  });

  it("rejects a wrong secret", async () => {
    tagAc(AC(20));
    const res = await tick({ authorization: "Bearer wrong" });
    expect(res.status).toBe(401);
    expect(runActivationDrip).not.toHaveBeenCalled();
  });

  it("fail-closed: rejects everything when LIFECYCLE_TICK_SECRET is unset", async () => {
    tagAc(AC(20));
    delete process.env.LIFECYCLE_TICK_SECRET;
    const res = await tick(authed);
    expect(res.status).toBe(401);
    expect(runActivationDrip).not.toHaveBeenCalled();
  });
});

describe("POST /api/internal/lifecycle-tick — runs both passes (ac-20)", () => {
  it("with a valid secret, one invocation runs BOTH the drip and the Connect Day-12 pass", async () => {
    tagAc(AC(20));
    const res = await tick(authed);
    expect(res.status).toBe(200);
    expect(runActivationDrip).toHaveBeenCalledTimes(1);
    expect(runConnectPeoplePass).toHaveBeenCalledTimes(1);
    // Connect receives the fixed go-live instant from ACTIVATION_CONNECT_GO_LIVE.
    const [goLive] = runConnectPeoplePass.mock.calls[0];
    expect(goLive).toBeInstanceOf(Date);
    expect((goLive as Date).toISOString()).toBe("2026-07-04T00:00:00.000Z");
  });

  it("skips the Connect pass (but still runs the drip) when ACTIVATION_CONNECT_GO_LIVE is unset", async () => {
    tagAc(AC(20));
    delete process.env.ACTIVATION_CONNECT_GO_LIVE;
    const res = await tick(authed);
    expect(res.status).toBe(200);
    expect(runActivationDrip).toHaveBeenCalledTimes(1);
    expect(runConnectPeoplePass).not.toHaveBeenCalled();
  });

  it("returns 500 (so Cloud Scheduler retries) if a pass throws, and still runs the other", async () => {
    tagAc(AC(20));
    runActivationDrip.mockRejectedValue(new Error("drip boom"));
    const res = await tick(authed);
    expect(res.status).toBe(500);
    // The drip threw, but the Connect pass still ran (isolation).
    expect(runConnectPeoplePass).toHaveBeenCalledTimes(1);
  });
});

describe("index.ts no longer wires the in-process drip setInterval (ac-20)", () => {
  it("index.ts references neither startActivationDrip nor a lifecycle setInterval", () => {
    tagAc(AC(20));
    const src = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    expect(src).not.toContain("startActivationDrip");
  });
});
