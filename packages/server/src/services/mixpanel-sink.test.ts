// Unit tests for the Mixpanel adapter (spec-244 t-5 / dec-2 / dec-9) — no network.

import { describe, it, expect, vi } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import type { UsageEvent } from "../db/schema.js";
import { MixpanelSink, toMixpanelEvent } from "./mixpanel-sink.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-244/acs";
const AC297 = "mindset-prod/memex-building-itself/specs/spec-297/acs";
const AC324 = "mindset-prod/memex-building-itself/specs/spec-324/acs";

function row(over: Partial<UsageEvent> = {}): UsageEvent {
  return {
    id: "row-1",
    memexId: "mx-1",
    actorUserId: "user-1",
    name: "spec.create_clicked",
    source: "frontend",
    props: { surface: "header_cta" },
    env: "prod",
    occurredAt: new Date(1_700_000_000_000),
    forwardedAt: null,
    createdAt: new Date(1_700_000_000_000),
    ...over,
  } as UsageEvent;
}

describe("toMixpanelEvent — mapping (ac-13)", () => {
  it("uses $insert_id=row id (idempotent), distinct_id=actor, stamps env + token", () => {
    tagAc(`${AC}/ac-13`);
    const ev = toMixpanelEvent(row(), "TOKEN_X");
    expect(ev.event).toBe("spec.create_clicked");
    expect(ev.properties.$insert_id).toBe("row-1"); // dedup key → at-least-once safe
    expect(ev.properties.distinct_id).toBe("user-1");
    expect(ev.properties.token).toBe("TOKEN_X");
    expect(ev.properties.time).toBe(1_700_000_000); // unix seconds
    expect(ev.properties.env).toBe("prod"); // dec-9 env stamp
    expect(ev.properties.surface).toBe("header_cta"); // props merged through
  });

  it("omits distinct_id when there is no actor rather than sending null", () => {
    tagAc(`${AC}/ac-13`);
    const ev = toMixpanelEvent(row({ actorUserId: null }), "T");
    expect(ev.properties.distinct_id).toBeUndefined();
  });

  it("sets ip='0' so Mixpanel does not geolocate from the Cloud Run egress IP (spec-297 ac-20)", () => {
    tagAc(`${AC297}/ac-20`);
    tagAc(`${AC297}/ac-4`); // scope PII line: ip=0 + opaque distinct_id (user UUID), no PII
    const ev = toMixpanelEvent(row(), "T");
    expect(ev.properties.ip).toBe("0");
    expect(ev.properties.distinct_id).toBe("user-1"); // opaque user id, never email/name
    expect(JSON.stringify(ev.properties)).not.toContain("@"); // no email anywhere
    // Holds even when the event carries props of its own (props merge after).
    const ev2 = toMixpanelEvent(row({ props: { spec_index: 3 } }), "T");
    expect(ev2.properties.ip).toBe("0");
    expect(ev2.properties.spec_index).toBe(3);
  });
});

describe("toMixpanelEvent — Simplified ID Merge / the identity stitch (spec-324 ac-7)", () => {
  it("authenticated row: distinct_id + $user_id = actor, no $device_id when no visitor", () => {
    tagAc(`${AC324}/ac-7`);
    const ev = toMixpanelEvent(row({ actorUserId: "user-1", visitorId: null }), "T");
    expect(ev.properties.distinct_id).toBe("user-1");
    expect(ev.properties.$user_id).toBe("user-1");
    expect(ev.properties.$device_id).toBeUndefined();
  });

  it("authenticated row carrying a visitor: emits BOTH $user_id and $device_id (the merge trigger)", () => {
    tagAc(`${AC324}/ac-7`);
    const ev = toMixpanelEvent(row({ actorUserId: "user-1", visitorId: "vis-9" }), "T");
    // An event with both ids is what makes Mixpanel stitch the device's pre-auth
    // events to the user under Simplified ID Merge.
    expect(ev.properties.distinct_id).toBe("user-1");
    expect(ev.properties.$user_id).toBe("user-1");
    expect(ev.properties.$device_id).toBe("vis-9");
  });

  it("anonymous row (visitor only): distinct_id='$device:<visitor>' + $device_id, no $user_id", () => {
    tagAc(`${AC324}/ac-7`);
    const ev = toMixpanelEvent(row({ actorUserId: null, visitorId: "vis-9" }), "T");
    // Pre-identity events land under the device until the merge resolves them —
    // this is how a visitor seen BEFORE they had an identity is captured.
    expect(ev.properties.$device_id).toBe("vis-9");
    expect(ev.properties.distinct_id).toBe("$device:vis-9");
    expect(ev.properties.$user_id).toBeUndefined();
  });

  it("neither id: emits none of distinct_id / $user_id / $device_id (nothing to attribute)", () => {
    tagAc(`${AC324}/ac-7`);
    const ev = toMixpanelEvent(row({ actorUserId: null, visitorId: null }), "T");
    expect(ev.properties.distinct_id).toBeUndefined();
    expect(ev.properties.$user_id).toBeUndefined();
    expect(ev.properties.$device_id).toBeUndefined();
  });
});

describe("MixpanelSink.send — server-side HTTP, US host (ac-2 / ac-13)", () => {
  it("POSTs a JSON batch to the US /track endpoint with the token in the body", async () => {
    tagAc(`${AC}/ac-13`);
    tagAc(`${AC}/ac-5`); // the curated forward set reaches Mixpanel in the default config
    const fetchImpl = vi.fn(async () => new Response("1", { status: 200 }));
    const sink = new MixpanelSink("PROD_TOKEN", fetchImpl as unknown as typeof fetch);
    await sink.send([row(), row({ id: "row-2", name: "cta.clicked" })]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.mixpanel.com/track"); // US host (dec-9)
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
    expect(body[0].properties.token).toBe("PROD_TOKEN");
  });

  it("throws on a non-2xx so the forwarder retries (ac-6)", async () => {
    tagAc(`${AC}/ac-6`);
    const fetchImpl = vi.fn(async () => new Response("0", { status: 503 }));
    const sink = new MixpanelSink("T", fetchImpl as unknown as typeof fetch);
    await expect(sink.send([row()])).rejects.toThrow(/503/);
  });
});

describe("per-env project separation (ac-19)", () => {
  it("forwards with the env-specific token value (int project vs prod project)", async () => {
    tagAc(`${AC}/ac-19`);
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      calls.push(body[0].properties.token);
      return new Response("1", { status: 200 });
    });
    // The int service carries the memex-int token; prod carries memex-prod's. Same
    // code, different MIXPANEL_TOKEN value per env — the dec-9 separation mechanism.
    await new MixpanelSink("memex-int-token", fetchImpl as unknown as typeof fetch).send([row({ env: "int" })]);
    await new MixpanelSink("memex-prod-token", fetchImpl as unknown as typeof fetch).send([row({ env: "prod" })]);
    expect(calls).toEqual(["memex-int-token", "memex-prod-token"]);
  });
});
