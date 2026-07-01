// spec-427 t-4 (ac-12) — the stateless unsubscribe token: stable, verifiable, no-PII,
// and (the load-bearing property) UNFORGEABLE — a tampered userId or MAC must never
// resolve to a valid user, or anyone could unsubscribe anyone.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  mintUnsubscribeToken,
  verifyUnsubscribeToken,
  unsubscribeUrl,
} from "./unsubscribe-token.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-427/acs/ac-${n}`;
const USER = "11111111-1111-1111-1111-111111111111";

describe("unsubscribe token — mint / verify round-trip", () => {
  it("verifies a freshly minted token back to its userId", () => {
    tagAc(AC(12));
    expect(verifyUnsubscribeToken(mintUnsubscribeToken(USER))).toBe(USER);
  });

  it("is stable — the same user always mints the same token (embeddable in every send)", () => {
    tagAc(AC(12));
    expect(mintUnsubscribeToken(USER)).toBe(mintUnsubscribeToken(USER));
  });

  it("carries no email / PII — only the (UUID) userId segment and a MAC", () => {
    tagAc(AC(12));
    const token = mintUnsubscribeToken(USER);
    expect(token).not.toContain("@");
    // exactly two base64url segments joined by a dot
    expect(token.split(".")).toHaveLength(2);
  });
});

describe("unsubscribe token — unforgeable (the negative that matters)", () => {
  it("rejects a tampered userId segment", () => {
    tagAc(AC(12));
    const [user, mac] = mintUnsubscribeToken(USER).split(".");
    const otherUser = Buffer.from("22222222-2222-2222-2222-222222222222", "utf8").toString("base64url");
    expect(user).not.toBe(otherUser);
    // swap in a different user but keep the original MAC → must not verify
    expect(verifyUnsubscribeToken(`${otherUser}.${mac}`)).toBeNull();
  });

  it("rejects a tampered MAC", () => {
    tagAc(AC(12));
    const [user] = mintUnsubscribeToken(USER).split(".");
    const forgedMac = Buffer.from("not-the-real-mac").toString("base64url");
    expect(verifyUnsubscribeToken(`${user}.${forgedMac}`)).toBeNull();
  });

  it("rejects malformed / empty tokens without throwing", () => {
    tagAc(AC(12));
    for (const bad of [undefined, null, "", "no-dot", "a.b.c", ".", "x."] as const) {
      expect(verifyUnsubscribeToken(bad as string | undefined | null)).toBeNull();
    }
  });
});

describe("unsubscribe URL — host from APP_BASE_URL (dec-8)", () => {
  const saved = process.env.APP_BASE_URL;
  beforeEach(() => { process.env.APP_BASE_URL = "https://int.memex.ai"; });
  afterEach(() => { process.env.APP_BASE_URL = saved; });

  it("builds an env-derived absolute URL carrying the verifiable token", () => {
    tagAc(AC(12));
    const url = unsubscribeUrl(USER);
    expect(url.startsWith("https://int.memex.ai/api/email/unsubscribe?token=")).toBe(true);
    const token = decodeURIComponent(new URL(url).searchParams.get("token")!);
    expect(verifyUnsubscribeToken(token)).toBe(USER);
  });
});
