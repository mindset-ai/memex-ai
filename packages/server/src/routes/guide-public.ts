// PUBLIC anonymous voice-guide backend (spec-222 t-10/t-11/t-12, dec-4/dec-9).
//
// This is the internet-facing sibling of routes/voice.ts. It serves the SAME
// ElevenLabs/Anthropic proxy + the SAME surface-keyed corpus/persona, but with
// NO login and NO tenant — the website embeds it (memex-website surface). The
// ONLY differences from the authenticated path are:
//
//   1. AUTH SOURCE (t-10) — instead of a user session token + canReadMemex, a
//      connection carries a short-lived SIGNED ANON token minted by
//      POST /guide/v1/session. The token binds {surface, issued_at, nonce}; it
//      has no user and no tenant. The WS/SSE legs accept ONLY a valid, unexpired
//      anon token and otherwise deny opaquely (std-7): WS closes 1008, SSE
//      refuses, neither leaks the reason.
//
//   2. ABUSE CONTROLS (t-11) — origin allowlist (defense-in-depth) on /session AND
//      the WS handshake; IP rate-limit on /session; and a PER-SESSION hard cap
//      (turns + wall-clock) enforced in the VoiceSession lifecycle. Provider keys
//      stay server-side (resolveVoiceProvider / the SSE proxy) — never in any
//      client-visible payload from these routes.
//
//   3. VERSIONING (t-12) — the whole surface is mounted under /guide/v1. The
//      bundle sends its protocol version on connect (?v= / x-guide-client-version);
//      the server accepts the CURRENT version and N-1, and warns/refuses an
//      incompatible (too-old) client.
//
// It does NOT fork the proxy logic: it reuses VoiceSession, assembleGuideContext,
// latestUserUtterance, handleGuideChat, buildGuideSystemBlocks, resolveVoiceProvider.
//
// Mounted in app.ts at /guide/v1 WITHOUT sessionMiddleware (mirrors the public
// waitlist mount) and outside the /<ns>/<mx>/ tenant prefix — there is no tenant.

import { Hono } from "hono";
import type { Context } from "hono";
import type { WSContext } from "hono/ws";
import type { createNodeWebSocket } from "@hono/node-ws";
import {
  signAnonGuideToken,
  verifyAnonGuideToken,
  type AnonGuideClaims,
} from "../services/auth-jwt.js";
import { assertGuideSurface, UnknownGuideSurfaceError } from "../services/guide-content.js";
import { isAllowedOrigin } from "../middleware/cors-policy.js";
import { rateLimit, AUTH_LIMITS } from "../services/auth-rate-limit.js";
import { clientIp } from "./auth/helpers.js";
import { isVoiceConfigured } from "../agent/elevenlabs-client.js";
import {
  VoiceSession,
  handleGuideChat,
  type VoiceAuthResult,
  type VoiceSessionCap,
} from "./voice.js";

type UpgradeWebSocket = ReturnType<typeof createNodeWebSocket>["upgradeWebSocket"];

// ── Versioning (t-12 → ac-25) ────────────────────────────────────────────────
//
// The path carries the MAJOR version (/guide/v1). The bundle ALSO sends a protocol
// version on connect so the server can detect a too-old vendored bundle (one that
// hasn't been re-copied to the marketing bucket yet) and warn/refuse it while a
// CURRENT or N-1 bundle keeps working. CURRENT is what this server speaks;
// MIN_SUPPORTED = CURRENT - 1 is the N-1 floor.
export const GUIDE_PROTOCOL_VERSION = 2;
export const GUIDE_MIN_SUPPORTED_VERSION = GUIDE_PROTOCOL_VERSION - 1; // N-1

export type ClientVersionVerdict =
  | { ok: true; version: number; warn: boolean }
  | { ok: false; reason: "too_old"; version: number; minSupported: number };

/**
 * Read the client's declared protocol version from the connect query (?v=) or the
 * x-guide-client-version header, and classify it. A MISSING version is treated as
 * the current version (a legacy bundle that predates versioning is rare and we
 * don't want to brick it on connect — the path is already /v1). CURRENT passes
 * silently; N-1 passes with a warn flag (the client is one behind); anything below
 * the floor is refused.
 */
export function classifyClientVersion(c: Context): ClientVersionVerdict {
  const raw = c.req.query("v") ?? c.req.header("x-guide-client-version");
  if (raw == null || raw === "") {
    return { ok: true, version: GUIDE_PROTOCOL_VERSION, warn: false };
  }
  const version = Number(raw);
  if (!Number.isInteger(version) || version <= 0) {
    // Garbage version string — refuse rather than guess.
    return {
      ok: false,
      reason: "too_old",
      version: Number.isFinite(version) ? version : 0,
      minSupported: GUIDE_MIN_SUPPORTED_VERSION,
    };
  }
  if (version < GUIDE_MIN_SUPPORTED_VERSION) {
    return { ok: false, reason: "too_old", version, minSupported: GUIDE_MIN_SUPPORTED_VERSION };
  }
  // N-1 (or anything between the floor and current) is accepted, but flagged so a
  // header can warn the client to re-copy the bundle. A NEWER-than-current client
  // is also accepted (forward-lenient) — it shouldn't happen, but refusing a
  // bundle that's ahead of the server would brick a mid-deploy window.
  return { ok: true, version, warn: version < GUIDE_PROTOCOL_VERSION };
}

// ── Origin allowlist (t-11 → ac-15) ──────────────────────────────────────────
//
// Defense-in-depth, NOT the primary control (the signed token is). We refuse a
// request whose Origin is outside isAllowedOrigin at BOTH /session and the WS
// handshake. A MISSING Origin is allowed: non-browser clients (and some WS
// handshakes) omit it, and the signed token + rate-limit + cap are the real gate.
export function originAllowed(c: Context): boolean {
  const origin = c.req.header("origin");
  if (!origin) return true; // no Origin to check (non-browser / native) — token gates it
  return isAllowedOrigin(origin);
}

// ── Per-session hard cap (t-11 → ac-16) ──────────────────────────────────────
//
// Public anonymous sessions are hard-capped so a connected client can't run
// unbounded TTS/LLM work on our keys. Tunable per-env without a redeploy.
function resolveSessionCap(): VoiceSessionCap {
  const turns = Number(process.env.MEMEX_GUIDE_MAX_TURNS);
  const wallMs = Number(process.env.MEMEX_GUIDE_MAX_WALL_MS);
  return {
    maxTurns: Number.isInteger(turns) && turns > 0 ? turns : 40,
    maxWallClockMs:
      Number.isFinite(wallMs) && wallMs > 0 ? wallMs : 10 * 60 * 1000, // 10 minutes
  };
}

// Opaque deny for the WS leg — std-7: a missing/expired/invalid token, a refused
// origin, and a too-old client are INDISTINGUISHABLE to the client (close 1008,
// no reason string).
const WS_DENY: VoiceAuthResult = { ok: false, closeCode: 1008, closeReason: "" };

/**
 * Authenticate a PUBLIC voice WS/SSE connection from the connect-query anon token
 * (?token=). Returns the bound surface on success; every failure returns the SAME
 * opaque deny (std-7) — refused origin, too-old version, missing/invalid/expired
 * token are indistinguishable. No verifySessionToken / canReadMemex here.
 */
export function authenticateGuidePublicConnection(
  c: Context,
): { auth: VoiceAuthResult; surface: string | null } {
  // Origin allowlist + version gate first (cheap, defense-in-depth) — but deny
  // opaquely either way so we don't reveal which gate failed.
  if (!originAllowed(c)) return { auth: WS_DENY, surface: null };
  if (!classifyClientVersion(c).ok) return { auth: WS_DENY, surface: null };

  const token = c.req.query("token");
  if (!token) return { auth: WS_DENY, surface: null };

  let claims: AnonGuideClaims;
  try {
    claims = verifyAnonGuideToken(token);
  } catch {
    return { auth: WS_DENY, surface: null };
  }
  // The token's surface MUST still be a configured surface (defensive — a token is
  // only ever minted for a validated surface, but never trust it blindly).
  try {
    assertGuideSurface(claims.surface);
  } catch {
    return { auth: WS_DENY, surface: null };
  }
  return {
    auth: { ok: true, closeCode: 1000, closeReason: "ok" },
    surface: claims.surface,
  };
}

function wsSink(ws: WSContext): { send(d: string): void; close(c: number, r: string): void } {
  return {
    send: (data) => {
      try {
        ws.send(data);
      } catch {
        /* socket already closing */
      }
    },
    close: (code, reason) => {
      try {
        ws.close(code, reason);
      } catch {
        /* already closing */
      }
    },
  };
}

function toBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

/** Stamp the version-warning header so a client one version behind learns it
 *  should re-copy the bundle (current/missing → no header). */
function applyVersionWarning(c: Context): void {
  const verdict = classifyClientVersion(c);
  if (verdict.ok && verdict.warn) {
    c.header("X-Guide-Client-Version-Warning", "outdated");
  }
}

/**
 * Build the PUBLIC anonymous guide router (mounted at /guide/v1 in app.ts).
 * upgradeWebSocket is injected from app.ts exactly as for createVoiceRouter.
 */
export function createGuidePublicRouter(upgradeWebSocket: UpgradeWebSocket): Hono {
  const router = new Hono();

  // POST /guide/v1/session — mint a short-lived signed anon token for a surface.
  // No auth, no tenant. Origin-gated + IP-rate-limited (t-11). The client posts
  // ONLY a surface id; an unknown surface is rejected (never a silent fallback).
  router.post("/session", async (c) => {
    // Origin allowlist (defense-in-depth). Refuse with an opaque 403 (std-7).
    if (!originAllowed(c)) return c.json({ error: "forbidden" }, 403);

    // Version handshake (t-12): a too-old client is refused; current/N-1 proceed.
    const version = classifyClientVersion(c);
    if (!version.ok) {
      return c.json(
        {
          error: "client_too_old",
          message:
            "This guide bundle is no longer supported. Reload the page to pick up the latest.",
          minSupported: version.minSupported,
        },
        426, // Upgrade Required
      );
    }

    // IP rate-limit (t-11 → ac-15). Over-limit → 429.
    const ip = clientIp(c);
    const rl = rateLimit("guideSession", ip, AUTH_LIMITS.guideSession);
    if (!rl.ok) {
      c.header("Retry-After", String(rl.retryAfterSec ?? 1));
      return c.json(
        { error: "too_many_requests", message: "Too many guide sessions, retry shortly." },
        429,
      );
    }

    const body = (await c.req.json().catch(() => null)) as { surface?: unknown } | null;
    const surfaceRaw = body?.surface;
    if (typeof surfaceRaw !== "string") {
      return c.json({ error: "invalid_surface" }, 400);
    }
    // Validate the surface — unknown surface is rejected (never minted).
    let surface: string;
    try {
      surface = assertGuideSurface(surfaceRaw);
    } catch (err) {
      if (err instanceof UnknownGuideSurfaceError) {
        return c.json({ error: "invalid_surface" }, 400);
      }
      throw err;
    }

    applyVersionWarning(c);
    const { token, expiresAt } = signAnonGuideToken(surface);
    // The response carries the token + expiry ONLY — never any provider key (ac-16).
    return c.json({ token, expiresAt, surface, protocolVersion: GUIDE_PROTOCOL_VERSION }, 201);
  });

  // WSS /guide/v1/voice?token=… — the ElevenLabs STT/TTS proxy, anonymous. Reuses
  // VoiceSession (the SAME proxy as the authenticated path) with the per-session
  // hard cap applied (t-11) and the surface bound from the verified anon token.
  router.get(
    "/voice",
    upgradeWebSocket((c) => {
      const configured = isVoiceConfigured();
      const { auth } = authenticateGuidePublicConnection(c);
      const cap = resolveSessionCap();
      let session: VoiceSession | null = null;

      return {
        onOpen(_evt, ws) {
          session = new VoiceSession(wsSink(ws), { configured, auth, cap });
          session.open();
        },
        onMessage(evt, _ws) {
          if (!session) return;
          const data = evt.data;
          if (typeof data === "string") {
            session.handleText(data);
            return;
          }
          const bytes = toBytes(data as ArrayBuffer | ArrayBufferView);
          if (bytes) session.handleBinary(bytes);
        },
        onClose() {
          session?.teardown();
        },
        onError() {
          session?.teardown();
        },
      };
    }),
  );

  // POST /guide/v1/chat — the anonymous LLM text leg (Anthropic, surface-keyed
  // persona + corpus). Reuses handleGuideChat with the surface bound from the anon
  // token. On any invalid/expired/missing token → refuse (401), opaquely (std-7).
  router.post("/chat", async (c) => {
    const { auth, surface } = authenticateGuidePublicConnection(c);
    if (!auth.ok || !surface) {
      // Opaque refusal — same shape regardless of why (origin / version / token).
      return c.json({ error: "unauthorized" }, 401);
    }
    applyVersionWarning(c);
    // assertGuideSurface already ran inside authenticate; surface is a GuideSurface.
    return handleGuideChat(c, assertGuideSurface(surface));
  });

  return router;
}
