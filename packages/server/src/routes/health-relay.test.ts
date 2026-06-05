// spec-156 W1 — the /api/health surface reports the relay LISTEN-connection
// status (ac-12). The std-17 post-deploy smoke asserts relay.listening on int
// and prod; this test pins the shape the smoke reads.

import { describe, it, expect, afterEach } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { app } from "../app.js";
import { ChangeBus } from "../services/bus.js";
import {
  PgBusRelay,
  setBusRelay,
  type ListenDriver,
  type NotifyDriver,
} from "../services/bus-relay.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-156/acs/ac-${n}`;

// Minimal no-op drivers — this test exercises the health surface, not delivery.
const noopListen: ListenDriver = {
  async listen(_channel, _callbacks) {
    /* established immediately */
  },
  async close() {},
};
const noopNotify: NotifyDriver = {
  async notify() {},
};

afterEach(() => {
  // Always clear the process-wide relay so we don't leak into other route tests.
  setBusRelay(null);
});

describe("spec-156 W1: /api/health reports relay status (ac-12)", () => {
  it("reports relay: null when no relay is attached (single-process / local dev)", async () => {
    tagAc(AC(12));
    setBusRelay(null);
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; relay: unknown };
    expect(body.status).toBe("ok");
    expect(body.relay).toBeNull();
  });

  it("reports relay.listening=true once the LISTEN connection is established", async () => {
    tagAc(AC(12));
    const bus = new ChangeBus();
    const relay = new PgBusRelay({
      bus,
      listenDriver: noopListen,
      notifyDriver: noopNotify,
      originId: "health-origin",
    });
    await relay.start();
    setBusRelay(relay);

    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      relay: { listening: boolean; status: string; originId: string };
    };
    expect(body.status).toBe("ok");
    expect(body.relay.listening).toBe(true);
    expect(body.relay.status).toBe("listening");
    expect(body.relay.originId).toBe("health-origin");

    await relay.stop();
  });

  it("reports relay.listening=false after the relay is stopped", async () => {
    tagAc(AC(12));
    const bus = new ChangeBus();
    const relay = new PgBusRelay({
      bus,
      listenDriver: noopListen,
      notifyDriver: noopNotify,
      originId: "health-origin",
    });
    await relay.start();
    await relay.stop();
    setBusRelay(relay);

    const res = await app.request("/api/health");
    const body = (await res.json()) as { relay: { listening: boolean; status: string } };
    expect(body.relay.listening).toBe(false);
    expect(body.relay.status).toBe("stopped");
  });
});
