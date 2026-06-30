// Unit tests for the Mixpanel /engage profile slice (spec-297 dec-7) — no network.

import { describe, it, expect, vi } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  extractEmailDomain,
  toEngagePayload,
  configuredProfileSink,
  MixpanelProfileSink,
} from "./mixpanel-profile.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-297/acs";

describe("extractEmailDomain — domain only, never the local part (ac-23)", () => {
  it("returns the lowercased domain", () => {
    tagAc(`${AC}/ac-23`);
    expect(extractEmailDomain("wic@mindset.ai")).toBe("mindset.ai");
    expect(extractEmailDomain("Someone@MEMEX.AI")).toBe("memex.ai");
    expect(extractEmailDomain("a.b+tag@sub.example.com")).toBe("sub.example.com");
  });
  it("returns null for malformed addresses (never a junk property)", () => {
    tagAc(`${AC}/ac-23`);
    expect(extractEmailDomain("")).toBeNull();
    expect(extractEmailDomain("noatsign")).toBeNull();
    expect(extractEmailDomain("@nolocal.com")).toBeNull();
    expect(extractEmailDomain("trailing@")).toBeNull();
    expect(extractEmailDomain(null)).toBeNull();
  });
});

describe("toEngagePayload — opaque, no PII (ac-23, ac-24)", () => {
  it("sets email_domain (domain only) and org_ids, with no full email and no name", () => {
    tagAc(`${AC}/ac-23`);
    tagAc(`${AC}/ac-24`);
    const p = toEngagePayload({
      userId: "user-uuid-1",
      emailDomain: "mindset.ai",
      orgIds: ["org-1", "org-2"],
    });
    expect(p.$distinct_id).toBe("user-uuid-1");
    expect(p.$ip).toBe("0"); // dec-4: no IP geolocation
    expect(p.$set.email_domain).toBe("mindset.ai");
    expect(p.$set.org_ids).toEqual(["org-1", "org-2"]); // ac-24: opaque org links

    // ac-23 PII line: no full email address, no name anywhere in the payload.
    const serialized = JSON.stringify(p);
    expect(serialized).not.toContain("@");
    expect(p.$set).not.toHaveProperty("$email");
    expect(p.$set).not.toHaveProperty("$name");
    expect(p.$set).not.toHaveProperty("name");
    expect(p.$set).not.toHaveProperty("email");
  });

  it("omits email_domain when unknown but still sets org_ids (even empty)", () => {
    tagAc(`${AC}/ac-24`);
    const p = toEngagePayload({ userId: "u", emailDomain: null, orgIds: [] });
    expect(p.$set).not.toHaveProperty("email_domain");
    expect(p.$set.org_ids).toEqual([]);
  });
});

describe("configuredProfileSink — gated solely on MIXPANEL_TOKEN (dec-5)", () => {
  it("returns null with no/blank token, a sink with one", () => {
    tagAc(`${AC}/ac-23`);
    expect(configuredProfileSink({} as NodeJS.ProcessEnv)).toBeNull();
    expect(configuredProfileSink({ MIXPANEL_TOKEN: "   " } as NodeJS.ProcessEnv)).toBeNull();
    expect(configuredProfileSink({ MIXPANEL_TOKEN: "tok" } as NodeJS.ProcessEnv)?.name).toBe(
      "mixpanel-profile",
    );
  });
});

describe("MixpanelProfileSink.send — US /engage host, token stamped (ac-24)", () => {
  it("POSTs profiles to the US /engage endpoint with $token stamped per profile", async () => {
    tagAc(`${AC}/ac-24`);
    const fetchImpl = vi.fn(async () => new Response("1", { status: 200 }));
    const sink = new MixpanelProfileSink("PROD_TOKEN", fetchImpl as unknown as typeof fetch);
    await sink.setProfiles([
      toEngagePayload({ userId: "u1", emailDomain: "mindset.ai", orgIds: ["o1"] }),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.mixpanel.com/engage");
    const body = JSON.parse(init.body as string);
    expect(body[0].$token).toBe("PROD_TOKEN");
    expect(body[0].$distinct_id).toBe("u1");
    expect(body[0].$set.org_ids).toEqual(["o1"]);
  });

  it("throws on non-2xx", async () => {
    tagAc(`${AC}/ac-24`);
    const fetchImpl = vi.fn(async () => new Response("0", { status: 500 }));
    const sink = new MixpanelProfileSink("T", fetchImpl as unknown as typeof fetch);
    await expect(
      sink.setProfiles([toEngagePayload({ userId: "u", emailDomain: null, orgIds: [] })]),
    ).rejects.toThrow(/500/);
  });
});
