// spec-251 t-1/t-3/t-6 — the mindset-website surface on the PUBLIC /guide/v1
// backend.
//
//   ac-1: POST /session accepts surface=mindset-website and mints a token BOUND
//     to that surface; unknown surfaces are still rejected before a token exists.
//   ac-4: https://www.mindset.ai and https://mindset.ai are accepted on /session
//     and the WS handshake; foreign origins fail opaquely (403 / close 1008,
//     empty reason — std-7); existing surfaces' origins keep working unchanged.
//   ac-11: session minting for mindset-website draws from the SAME per-IP
//     AUTH_LIMITS.guideSession bucket as the other surfaces (dec-2: shared caps).
//   ac-12: the per-session caps are surface-agnostic — resolveSessionCap takes no
//     surface and reads only the two global env overrides (zero per-surface config).
//
// Mock posture mirrors guide-public.test.ts: retrieval is mocked so no DB is
// needed; the WS handshake runs over a REAL socket with the fake voice provider.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tagAc } from "@memex-ai-ac/vitest";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-251";
const AC1 = `${SPEC}/acs/ac-1`;
const AC4 = `${SPEC}/acs/ac-4`;
const AC11 = `${SPEC}/acs/ac-11`;
const AC12 = `${SPEC}/acs/ac-12`;

const __dirname = dirname(fileURLToPath(import.meta.url));

// Mock retrieval so the router runs without a DB. assertGuideSurface /
// GUIDE_SURFACES are real (the router + token verify lean on them).
vi.mock("../services/guide-content.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/guide-content.js")>();
  return {
    ...actual,
    prefetchScreenContent: vi.fn().mockResolvedValue([]),
    searchGuideContent: vi.fn().mockResolvedValue([]),
  };
});

import {
  createGuidePublicRouter,
  authenticateGuidePublicConnection,
  GUIDE_PROTOCOL_VERSION,
} from "./guide-public.js";
import { signAnonGuideToken } from "../services/auth-jwt.js";
import { resetRateLimits, AUTH_LIMITS } from "../services/auth-rate-limit.js";
import {
  __resetVoiceProviderForTests,
  isVoiceConfigured,
} from "../agent/elevenlabs-client.js";
import { clearFakeVoiceQueue } from "../agent/elevenlabs-fake.js";

const stubUpgrade = ((_handler: unknown) => async (_c: unknown, next: () => Promise<void>) =>
  next()) as unknown as Parameters<typeof createGuidePublicRouter>[0];

function makeApp(): Hono {
  const app = new Hono();
  app.route("/guide/v1", createGuidePublicRouter(stubUpgrade));
  return app;
}

async function mintSession(
  app: Hono,
  opts: { surface: string; origin?: string; ip?: string },
): Promise<Response> {
  return app.request("/guide/v1/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(opts.origin ? { origin: opts.origin } : {}),
      ...(opts.ip ? { "x-forwarded-for": opts.ip } : {}),
    },
    body: JSON.stringify({ surface: opts.surface }),
  });
}

beforeEach(() => {
  vi.stubEnv("AUTH_JWT_SECRET", "x".repeat(48));
  resetRateLimits();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

// ── ac-1: mint accepts mindset-website and binds it into the token ────────────

describe("POST /guide/v1/session — mindset-website surface (ac-1)", () => {
  it("mints a token for surface=mindset-website, bound to that surface", async () => {
    tagAc(AC1);
    const app = makeApp();
    const res = await mintSession(app, {
      surface: "mindset-website",
      origin: "https://www.mindset.ai",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token: string; surface: string };
    expect(body.surface).toBe("mindset-website");

    // The token verifies and carries the mindset-website surface — the binding
    // retrieval isolation hangs off.
    const { auth, surface } = authenticateGuidePublicConnection({
      req: {
        query: (k: string) => (k === "token" ? body.token : undefined),
        header: () => undefined,
      },
    } as never);
    expect(auth.ok).toBe(true);
    expect(surface).toBe("mindset-website");
  });

  it("still rejects an unknown surface at mint — no token is ever issued", async () => {
    tagAc(AC1);
    const app = makeApp();
    const res = await mintSession(app, {
      surface: "mindset-website-staging",
      origin: "https://www.mindset.ai",
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).not.toContain("token");
  });

  it("the existing surfaces still mint (unchanged behaviour)", async () => {
    tagAc(AC1);
    const app = makeApp();
    for (const surface of ["memex-app", "memex-website"]) {
      const res = await mintSession(app, {
        surface,
        origin: "https://www.memex.ai",
        ip: `7.7.7.${surface.length}`,
      });
      expect(res.status).toBe(201);
    }
  });
});

// ── ac-4: the mindset.ai origins on /session + WS handshake ───────────────────

describe("origin allowlist — mindset.ai origins (ac-4)", () => {
  it("accepts https://www.mindset.ai and the apex https://mindset.ai on /session", async () => {
    tagAc(AC4);
    const app = makeApp();
    for (const [i, origin] of ["https://www.mindset.ai", "https://mindset.ai"].entries()) {
      const res = await mintSession(app, {
        surface: "mindset-website",
        origin,
        ip: `6.6.6.${i}`,
      });
      expect(res.status).toBe(201);
    }
  });

  it("existing origins keep working; foreign origins still fail opaquely with 403", async () => {
    tagAc(AC4);
    const app = makeApp();
    const ok = await mintSession(app, {
      surface: "memex-website",
      origin: "https://www.memex.ai",
    });
    expect(ok.status).toBe(201);

    for (const origin of [
      "https://evil.example.com",
      "https://mindset.ai.evil.com",
      "http://www.mindset.ai", // http, not https
    ]) {
      const res = await mintSession(app, { surface: "mindset-website", origin });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
    }
  });
});

// ── ac-11: the per-IP mint limit is ONE shared bucket across surfaces ─────────

describe("shared per-IP session rate limit (dec-2 → ac-11)", () => {
  it("minting across DIFFERENT surfaces from one IP draws down a single bucket", async () => {
    tagAc(AC11);
    const app = makeApp();
    const limit = AUTH_LIMITS.guideSession.max;
    const surfaces = ["mindset-website", "memex-website", "memex-app"];

    // Alternate surfaces from the SAME IP: if the bucket were per-surface, the
    // (limit+1)th request would still be far under any per-surface budget. It
    // must 429 — proving one shared pool per IP, exactly as dec-2 resolved.
    let status = 0;
    for (let i = 0; i <= limit; i++) {
      const res = await mintSession(app, {
        surface: surfaces[i % surfaces.length],
        origin: "https://www.mindset.ai",
        ip: "8.8.8.8",
      });
      status = res.status;
    }
    expect(status).toBe(429);

    // A different IP is unaffected (the limit is per-IP, not global).
    const other = await mintSession(app, {
      surface: "mindset-website",
      origin: "https://www.mindset.ai",
      ip: "8.8.4.4",
    });
    expect(other.status).toBe(201);
  });

  it("there is exactly ONE guideSession limit entry — no per-surface budgets", () => {
    tagAc(AC11);
    const rateLimitSrc = readFileSync(
      resolve(__dirname, "../services/auth-rate-limit.ts"),
      "utf8",
    );
    expect(rateLimitSrc).toContain("guideSession");
    // No surface-keyed siblings crept in (dec-2 chose zero new config).
    expect(rateLimitSrc).not.toMatch(/guideSession[A-Z]\w*:/);
    expect(rateLimitSrc).not.toContain("mindset");
  });
});

// ── ac-12: per-session caps are surface-agnostic (zero diff) ──────────────────

describe("per-session caps stay global (dec-2 → ac-12)", () => {
  it("resolveSessionCap takes no surface and reads only the two global env overrides", () => {
    tagAc(AC12);
    const src = readFileSync(resolve(__dirname, "guide-public.ts"), "utf8");
    // The cap resolver is parameterless — there is no per-surface branch.
    expect(src).toMatch(/function resolveSessionCap\(\)/);
    // Only the two global knobs exist; no surface-suffixed variants.
    expect(src).toContain("MEMEX_GUIDE_MAX_TURNS");
    expect(src).toContain("MEMEX_GUIDE_MAX_WALL_MS");
    expect(src).not.toMatch(/MEMEX_GUIDE_MAX_TURNS_[A-Z]/);
    expect(src).not.toMatch(/MEMEX_GUIDE_MAX_WALL_MS_[A-Z]/);
    expect(src).not.toMatch(/resolveSessionCap\([^)]+\)/); // never called with args
  });
});

// ── ac-4 (WS leg): real-socket handshake with the mindset.ai origin ───────────

describe("WSS /guide/v1/voice — mindset.ai origin on the real handshake (ac-4)", () => {
  let server: ReturnType<typeof serve>;
  let port: number;
  const clients: WebSocket[] = [];

  beforeEach(async () => {
    process.env.MEMEX_ELEVENLABS_FAKE = "1";
    __resetVoiceProviderForTests();
    clearFakeVoiceQueue();
    expect(isVoiceConfigured()).toBe(true);

    const app = new Hono();
    const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
    app.route("/guide/v1", createGuidePublicRouter(upgradeWebSocket));
    server = serve({ fetch: app.fetch, port: 0 });
    injectWebSocket(server);
    await new Promise((r) => setImmediate(r));
    port = (server as unknown as { address: () => AddressInfo }).address().port;
  });
  afterEach(async () => {
    for (const ws of clients) {
      try {
        ws.terminate();
      } catch {
        /* gone */
      }
    }
    clients.length = 0;
    delete process.env.MEMEX_ELEVENLABS_FAKE;
    __resetVoiceProviderForTests();
    await new Promise<void>((res) => server.close(() => res()));
  });

  function open(opts: { token?: string; origin?: string }) {
    const qs = new URLSearchParams({ v: String(GUIDE_PROTOCOL_VERSION) });
    if (opts.token !== undefined) qs.set("token", opts.token);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/guide/v1/voice?${qs.toString()}`, {
      headers: opts.origin ? { origin: opts.origin } : undefined,
    });
    clients.push(ws);
    const msgs: Array<{ type: string }> = [];
    let closeCode: number | null = null;
    let closeReason = "";
    ws.on("message", (d: Buffer) => {
      try {
        msgs.push(JSON.parse(d.toString()) as { type: string });
      } catch {
        /* ignore */
      }
    });
    ws.on("close", (code: number, reason: Buffer) => {
      closeCode = code;
      closeReason = reason.toString();
    });
    ws.on("error", () => {
      /* close records the code */
    });
    return { msgs, getClose: () => closeCode, getReason: () => closeReason };
  }

  async function until(pred: () => boolean, ms = 3000): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (pred()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("condition not reached");
  }

  it("readies a mindset-website session from both mindset.ai origins", async () => {
    tagAc(AC4);
    tagAc(AC1);
    for (const origin of ["https://www.mindset.ai", "https://mindset.ai"]) {
      const token = signAnonGuideToken("mindset-website").token;
      const c = open({ token, origin });
      await until(() => c.msgs.some((m) => m.type === "ready"));
      expect(c.msgs.some((m) => m.type === "ready")).toBe(true);
    }
  });

  it("closes 1008 with an EMPTY reason for a foreign origin, even with a valid mindset token", async () => {
    tagAc(AC4);
    const token = signAnonGuideToken("mindset-website").token;
    const c = open({ token, origin: "https://evil.example.com" });
    await until(() => c.getClose() !== null);
    expect(c.getClose()).toBe(1008);
    expect(c.getReason()).toBe(""); // opaque, std-7
    expect(c.msgs.some((m) => m.type === "ready")).toBe(false);
  });
});
