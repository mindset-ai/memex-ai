// spec-222 t-10/t-11/t-12 — the PUBLIC anonymous voice-guide backend.
//
//   t-10 (ac-14): /session mints a short-lived signed anon token; the SSE /chat
//     leg accepts ONLY a valid/unexpired token (unknown surface rejected at mint).
//   t-11 (ac-15/ac-16/ac-5): origin allowlist at /session + WS handshake; IP
//     rate-limit on /session (over-limit → 429); per-session hard cap (turns +
//     wall-clock) ends the session and refuses further TTS/LLM work; no provider
//     key in any client-visible payload.
//   t-12 (ac-25): /guide/v1 versioned path; the client sends its version on
//     connect; current + N-1 accepted, too-old warned/refused.
//
// HTTP routes are exercised with app.request; the WS handshake (origin + token +
// version) is exercised over a REAL socket; the per-session cap is unit-tested on
// VoiceSession directly. The Anthropic client + retrieval are mocked, so no DB or
// real key is needed; the voice provider is the deterministic fake.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { tagAc } from "@memex-ai-ac/vitest";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-222";
const AC14 = `${SPEC}/acs/ac-14`;
const AC15 = `${SPEC}/acs/ac-15`;
const AC16 = `${SPEC}/acs/ac-16`;
const AC5 = `${SPEC}/acs/ac-5`;
const AC25 = `${SPEC}/acs/ac-25`;

// Mock retrieval so the SSE leg runs without a DB. assertGuideSurface/Unknown… are
// real (the router + token verify lean on them).
vi.mock("../services/guide-content.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/guide-content.js")>();
  return {
    ...actual,
    prefetchScreenContent: vi.fn().mockResolvedValue([]),
    searchGuideContent: vi.fn().mockResolvedValue([]),
  };
});

// Capture what the SSE leg hands Anthropic (to assert surface-driven persona +
// that no key leaks).
const streamArgs = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));
vi.mock("../agent/anthropic-client.js", () => ({
  LlmNotConfiguredError: class LlmNotConfiguredError extends Error {},
  getAnthropicClient: () => ({
    messages: {
      stream: (args: Record<string, unknown>) => {
        streamArgs.last = args;
        return {
          on(event: string, cb: (t: string) => void) {
            if (event === "text") cb("Welcome to Memex.");
            return this;
          },
          finalMessage: async () => ({
            content: [{ type: "text", text: "Welcome to Memex." }],
            stop_reason: "end_turn",
          }),
        };
      },
    },
  }),
}));

import {
  createGuidePublicRouter,
  classifyClientVersion,
  originAllowed,
  authenticateGuidePublicConnection,
  GUIDE_PROTOCOL_VERSION,
  GUIDE_MIN_SUPPORTED_VERSION,
} from "./guide-public.js";
import { signAnonGuideToken } from "../services/auth-jwt.js";
import { resetRateLimits } from "../services/auth-rate-limit.js";
import { VoiceSession, type VoiceSink, type VoiceAuthResult } from "./voice.js";
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

const ALLOWED_ORIGIN = "https://www.memex.ai";

beforeEach(() => {
  vi.stubEnv("AUTH_JWT_SECRET", "x".repeat(48));
  resetRateLimits();
  streamArgs.last = null;
});
afterEach(() => {
  vi.unstubAllEnvs();
});

// ── t-10: /session mint + unknown surface rejection (ac-14) ───────────────────

describe("POST /guide/v1/session — anon token mint (ac-14)", () => {
  it("mints a short-lived signed token for a valid surface and returns its expiry", async () => {
    tagAc(AC14);
    const app = makeApp();
    const res = await app.request("/guide/v1/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", origin: ALLOWED_ORIGIN },
      body: JSON.stringify({ surface: "memex-website" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token: string; expiresAt: number; surface: string };
    expect(typeof body.token).toBe("string");
    expect(body.surface).toBe("memex-website");
    expect(body.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    // Token verifies and is bound to the surface; carries no user/tenant.
    const { auth, surface } = authenticateGuidePublicConnection({
      req: {
        query: (k: string) => (k === "token" ? body.token : undefined),
        header: () => undefined,
      },
    } as never);
    expect(auth.ok).toBe(true);
    expect(surface).toBe("memex-website");
  });

  it("rejects an unknown surface at mint (never minted, never a silent fallback)", async () => {
    tagAc(AC14);
    const app = makeApp();
    const res = await app.request("/guide/v1/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", origin: ALLOWED_ORIGIN },
      body: JSON.stringify({ surface: "the-whole-corpus" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a missing/non-string surface", async () => {
    tagAc(AC14);
    const app = makeApp();
    const res = await app.request("/guide/v1/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", origin: ALLOWED_ORIGIN },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("never returns a provider key in the mint response (ac-16/ac-5)", async () => {
    tagAc(AC16);
    tagAc(AC5);
    vi.stubEnv("ELEVENLABS_API_KEY", "sk-eleven-SECRET-should-never-leak");
    const app = makeApp();
    const res = await app.request("/guide/v1/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", origin: ALLOWED_ORIGIN },
      body: JSON.stringify({ surface: "memex-website" }),
    });
    const text = await res.text();
    expect(text).not.toContain("sk-eleven-SECRET");
    expect(text).not.toContain("ELEVENLABS");
  });
});

// ── t-11: origin allowlist + rate limit at /session (ac-15) ───────────────────

describe("POST /guide/v1/session — abuse controls (ac-15)", () => {
  it("refuses a request whose Origin is outside the allowlist", async () => {
    tagAc(AC15);
    const app = makeApp();
    const res = await app.request("/guide/v1/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", origin: "https://evil.example.com" },
      body: JSON.stringify({ surface: "memex-website" }),
    });
    expect(res.status).toBe(403);
  });

  it("rate-limits per IP — over-limit requests get 429", async () => {
    tagAc(AC15);
    const app = makeApp();
    const limit = 20; // AUTH_LIMITS.guideSession.max
    let last = 201;
    for (let i = 0; i < limit + 2; i++) {
      const res = await app.request("/guide/v1/session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          origin: ALLOWED_ORIGIN,
          "x-forwarded-for": "9.9.9.9",
        },
        body: JSON.stringify({ surface: "memex-website" }),
      });
      last = res.status;
    }
    expect(last).toBe(429);
  });
});

// ── t-12: version handshake (ac-25) ───────────────────────────────────────────

describe("version handshake (ac-25)", () => {
  function ctx(opts: { v?: string; header?: string }): Parameters<typeof classifyClientVersion>[0] {
    return {
      req: {
        query: (k: string) => (k === "v" ? opts.v : undefined),
        header: (k: string) => (k.toLowerCase() === "x-guide-client-version" ? opts.header : undefined),
      },
    } as never;
  }

  it("accepts the current version (no warning)", () => {
    tagAc(AC25);
    const v = classifyClientVersion(ctx({ v: String(GUIDE_PROTOCOL_VERSION) }));
    expect(v.ok).toBe(true);
    expect(v.ok && v.warn).toBe(false);
  });

  it("accepts an N-1 version (with a warn flag)", () => {
    tagAc(AC25);
    const v = classifyClientVersion(ctx({ v: String(GUIDE_MIN_SUPPORTED_VERSION) }));
    expect(v.ok).toBe(true);
    expect(v.ok && v.warn).toBe(true);
  });

  it("refuses an incompatible/too-old version", () => {
    tagAc(AC25);
    const v = classifyClientVersion(ctx({ v: String(GUIDE_MIN_SUPPORTED_VERSION - 1) }));
    expect(v.ok).toBe(false);
  });

  it("reads the version from the x-guide-client-version header too", () => {
    tagAc(AC25);
    const v = classifyClientVersion(ctx({ header: String(GUIDE_MIN_SUPPORTED_VERSION - 1) }));
    expect(v.ok).toBe(false);
  });

  it("/session refuses a too-old client with 426 Upgrade Required", async () => {
    tagAc(AC25);
    const app = makeApp();
    const res = await app.request(
      `/guide/v1/session?v=${GUIDE_MIN_SUPPORTED_VERSION - 1}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", origin: ALLOWED_ORIGIN },
        body: JSON.stringify({ surface: "memex-website" }),
      },
    );
    expect(res.status).toBe(426);
  });

  it("/session accepts a current client (201) and an N-1 client (201 + warning header)", async () => {
    tagAc(AC25);
    const app = makeApp();
    const current = await app.request(`/guide/v1/session?v=${GUIDE_PROTOCOL_VERSION}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", origin: ALLOWED_ORIGIN },
      body: JSON.stringify({ surface: "memex-website" }),
    });
    expect(current.status).toBe(201);
    expect(current.headers.get("X-Guide-Client-Version-Warning")).toBeNull();

    const n1 = await app.request(`/guide/v1/session?v=${GUIDE_MIN_SUPPORTED_VERSION}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        origin: ALLOWED_ORIGIN,
        "x-forwarded-for": "5.5.5.5",
      },
      body: JSON.stringify({ surface: "memex-website" }),
    });
    expect(n1.status).toBe(201);
    expect(n1.headers.get("X-Guide-Client-Version-Warning")).toBe("outdated");
  });
});

// ── t-10/t-11: SSE /chat token gate + surface-keyed persona (ac-14/ac-5) ──────

describe("POST /guide/v1/chat — token gate (ac-14)", () => {
  function mint(surface = "memex-website"): string {
    return signAnonGuideToken(surface).token;
  }

  async function chat(query: string, headers: Record<string, string> = {}): Promise<Response> {
    const app = makeApp();
    return app.request(`/guide/v1/chat${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", origin: ALLOWED_ORIGIN, ...headers },
      body: JSON.stringify({ messages: [{ role: "user", content: "what is Memex?" }] }),
    });
  }

  it("refuses (401) a missing token, opaquely (std-7)", async () => {
    tagAc(AC14);
    const res = await chat("");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "unauthorized" });
  });

  it("refuses (401) an invalid token", async () => {
    tagAc(AC14);
    const res = await chat("?token=garbage");
    expect(res.status).toBe(401);
  });

  it("refuses (401) an expired token", async () => {
    tagAc(AC14);
    const expired = signAnonGuideToken("memex-website", -1).token;
    const res = await chat(`?token=${expired}`);
    expect(res.status).toBe(401);
  });

  it("refuses (401) when the Origin is outside the allowlist, even with a valid token", async () => {
    tagAc(AC15);
    const res = await chat(`?token=${mint()}`, { origin: "https://evil.example.com" });
    expect(res.status).toBe(401);
  });

  it("accepts a valid token and drives the website persona from the bound surface", async () => {
    tagAc(AC14);
    const res = await chat(`?token=${mint("memex-website")}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("event: message_complete");
    // The surface the SSE proxy hands Anthropic is the website persona, not app.
    // (buildGuideSystemBlocks for memex-website excludes the demo walkthrough beats.)
    const system = JSON.stringify(streamArgs.last?.system ?? []);
    expect(system).not.toContain("Demo walkthrough beats");
  });

  it("never leaks a provider key in the SSE response (ac-16/ac-5)", async () => {
    tagAc(AC16);
    tagAc(AC5);
    vi.stubEnv("ELEVENLABS_API_KEY", "sk-eleven-SECRET-should-never-leak");
    const res = await chat(`?token=${mint()}`);
    const text = await res.text();
    expect(text).not.toContain("sk-eleven-SECRET");
  });
});

// ── t-11: per-session hard cap on VoiceSession (ac-16/ac-5) ────────────────────

describe("per-session hard cap (ac-16)", () => {
  const OK_AUTH: VoiceAuthResult = { ok: true, closeCode: 1000, closeReason: "ok" };

  function recordingSink() {
    const sent: Array<Record<string, unknown>> = [];
    const closed: Array<{ code: number; reason: string }> = [];
    const sink: VoiceSink = {
      send: (d) => sent.push(JSON.parse(d) as Record<string, unknown>),
      close: (code, reason) => closed.push({ code, reason }),
    };
    return { sink, sent, closed };
  }
  const flush = () => new Promise((r) => setTimeout(r, 10));

  beforeEach(() => {
    process.env.MEMEX_ELEVENLABS_FAKE = "1";
    __resetVoiceProviderForTests();
    clearFakeVoiceQueue();
  });
  afterEach(() => {
    delete process.env.MEMEX_ELEVENLABS_FAKE;
    __resetVoiceProviderForTests();
  });

  it("ends the session and refuses further TTS work once the turn cap is hit", async () => {
    tagAc(AC16);
    tagAc(AC5);
    const { sink, sent, closed } = recordingSink();
    const s = new VoiceSession(sink, {
      configured: true,
      auth: OK_AUTH,
      cap: { maxTurns: 2, maxWallClockMs: 60_000 },
    });
    s.open();
    s.handleText(JSON.stringify({ type: "speak", requestId: "r1", text: "one" }));
    s.handleText(JSON.stringify({ type: "speak", requestId: "r2", text: "two" }));
    // Third speak is over the cap → session ends, NO audio for r3.
    s.handleText(JSON.stringify({ type: "speak", requestId: "r3", text: "three" }));
    await flush();

    expect(s.isCapExceeded()).toBe(true);
    expect(closed.some((x) => x.code === 1011)).toBe(true);
    expect(sent.some((m) => m.type === "error" && m.message === "session_limit_reached")).toBe(true);
    // No TTS audio was produced for the over-cap turn.
    expect(sent.some((m) => m.type === "audio" && m.requestId === "r3")).toBe(false);
    // Further frames after the cap do nothing.
    const before = sent.length;
    s.handleText(JSON.stringify({ type: "speak", requestId: "r4", text: "four" }));
    await flush();
    expect(sent.length).toBe(before);
  });

  it("ends the session on the wall-clock cap and refuses further work", async () => {
    tagAc(AC16);
    const { sink, sent, closed } = recordingSink();
    const s = new VoiceSession(sink, {
      configured: true,
      auth: OK_AUTH,
      cap: { maxTurns: 1000, maxWallClockMs: 0 }, // already over budget at open
    });
    s.open();
    // The very next frame trips the wall-clock cap via active().
    s.handleText(JSON.stringify({ type: "speak", requestId: "r1", text: "hello" }));
    await flush();
    expect(s.isCapExceeded()).toBe(true);
    expect(closed.some((x) => x.code === 1011)).toBe(true);
    expect(sent.some((m) => m.type === "audio")).toBe(false);
  });

  it("the authenticated in-app path (no cap) is unbounded — behaviour unchanged", async () => {
    const { sink, sent } = recordingSink();
    const s = new VoiceSession(sink, { configured: true, auth: OK_AUTH }); // no cap
    s.open();
    for (let i = 0; i < 5; i++) {
      s.handleText(JSON.stringify({ type: "speak", requestId: `r${i}`, text: "go" }));
    }
    await flush();
    expect(s.isCapExceeded()).toBe(false);
    expect(sent.some((m) => m.type === "audio")).toBe(true);
  });
});

// ── origin helper unit (ac-15 defense-in-depth) ───────────────────────────────

describe("originAllowed (ac-15)", () => {
  function ctx(origin?: string): Parameters<typeof originAllowed>[0] {
    return { req: { header: (k: string) => (k === "origin" ? origin : undefined) } } as never;
  }
  it("allows allowlisted origins and a missing origin; refuses others", () => {
    tagAc(AC15);
    expect(originAllowed(ctx("https://www.memex.ai"))).toBe(true);
    expect(originAllowed(ctx("http://localhost:5173"))).toBe(true);
    expect(originAllowed(ctx(undefined))).toBe(true); // non-browser, token gates it
    expect(originAllowed(ctx("https://evil.example.com"))).toBe(false);
  });
});

// ── WS handshake: real socket — origin + token + version gates (ac-14/ac-15) ──

describe("WSS /guide/v1/voice — real handshake (ac-14/ac-15)", () => {
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function open(opts: { token?: string; v?: number; origin?: string }) {
    const qs = new URLSearchParams();
    if (opts.token !== undefined) qs.set("token", opts.token);
    if (opts.v !== undefined) qs.set("v", String(opts.v));
    const s = qs.toString();
    const headers = opts.origin ? { origin: opts.origin } : undefined;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/guide/v1/voice${s ? `?${s}` : ""}`, {
      headers,
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
    return { ws, msgs, getClose: () => closeCode, getReason: () => closeReason };
  }

  async function waitClose(get: () => number | null, ms = 3000): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (get() !== null) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("ws did not close");
  }
  async function waitReady(msgs: Array<{ type: string }>, ms = 3000): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (msgs.some((m) => m.type === "ready")) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("ws never readied");
  }

  it("accepts a valid token + current version (sends 'ready')", async () => {
    tagAc(AC14);
    const token = signAnonGuideToken("memex-website").token;
    const c = open({ token, v: GUIDE_PROTOCOL_VERSION, origin: ALLOWED_ORIGIN });
    await waitReady(c.msgs);
    expect(c.msgs.some((m) => m.type === "ready")).toBe(true);
  });

  it("accepts an N-1 version", async () => {
    tagAc(AC25);
    const token = signAnonGuideToken("memex-website").token;
    const c = open({ token, v: GUIDE_MIN_SUPPORTED_VERSION, origin: ALLOWED_ORIGIN });
    await waitReady(c.msgs);
    expect(c.msgs.some((m) => m.type === "ready")).toBe(true);
  });

  it("closes 1008 (no 'ready') on a missing, invalid, or expired token — opaquely", async () => {
    tagAc(AC14);
    for (const token of [undefined, "garbage", signAnonGuideToken("memex-website", -1).token]) {
      const c = open({ token, v: GUIDE_PROTOCOL_VERSION, origin: ALLOWED_ORIGIN });
      await waitClose(c.getClose);
      expect(c.getClose()).toBe(1008);
      expect(c.getReason()).toBe(""); // no reason leaked (std-7)
      expect(c.msgs.some((m) => m.type === "ready")).toBe(false);
    }
  });

  it("closes 1008 when the Origin is outside the allowlist, even with a valid token", async () => {
    tagAc(AC15);
    const token = signAnonGuideToken("memex-website").token;
    const c = open({ token, v: GUIDE_PROTOCOL_VERSION, origin: "https://evil.example.com" });
    await waitClose(c.getClose);
    expect(c.getClose()).toBe(1008);
    expect(c.msgs.some((m) => m.type === "ready")).toBe(false);
  });

  it("closes 1008 on a too-old client version", async () => {
    tagAc(AC25);
    const token = signAnonGuideToken("memex-website").token;
    const c = open({
      token,
      v: GUIDE_MIN_SUPPORTED_VERSION - 1,
      origin: ALLOWED_ORIGIN,
    });
    await waitClose(c.getClose);
    expect(c.getClose()).toBe(1008);
  });
});
