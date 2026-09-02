// spec-544 — the live Standard list is read with NO credential, in ONE call.
//
// This is the single network edge of the comparator. Its sibling file
// (spec-544-standards-live-plan) covers the pure plan; keeping them apart is what
// lets `make check` stay offline (ac-10) while both halves stay covered.
//
// WHY "no credential" is a pinned property and not an accident: the generator's own
// header used to justify the offline mirror with "CI holds no Memex credentials".
// That premise was over-broad — reading this Memex needs no credential at all,
// because it is public by design (std-31) and every GET goes behind the permissive
// public session, resolving public → read / private → 404 (std-7). Verified live
// 2026-09-02: 200, 51 rows, unauthenticated. If someone later "fixes" this by
// attaching a token, the fix would be a regression: it would couple a public read to
// a secret that can expire, and reintroduce exactly the silent-stop failure dec-3
// designed out.
//
// The stub is restored in afterEach per std-37 — a leaked global fetch would poison
// every suite sharing the worker.

import { describe, it, expect, vi, afterEach } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { fetchLiveStandards } from "../../../../scripts/ci/standards-index.mjs";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-544/acs/ac-${n}`;

const URL_UNDER_TEST =
  "https://memex.ai/api/mindset-prod/memex-building-itself/docs?type=standard&include=tags";

const okJson = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("spec-544: the live read carries no credential and costs one call", () => {
  it("sends no Authorization, Cookie or secret of any kind (ac-7)", async () => {
    tagAc(AC(7));

    const spy = vi.fn(async () => okJson([{ handle: "std-1", title: "T", tags: [] }]));
    vi.stubGlobal("fetch", spy);

    await fetchLiveStandards(URL_UNDER_TEST);

    expect(spy).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = spy.mock.calls[0] as unknown as [
      string,
      RequestInit | undefined,
    ];

    // Whatever headers were passed (most likely none at all), none may be an
    // credential-bearing one.
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(
        ([k, v]) => [k.toLowerCase(), v],
      ),
    );
    for (const forbidden of ["authorization", "cookie", "x-api-key"]) {
      expect(
        headers[forbidden],
        `The live read must stay unauthenticated — a "${forbidden}" header couples a ` +
          `PUBLIC read to a secret that can expire, and a silently-expiring credential ` +
          `is the failure dec-3 exists to avoid.`,
      ).toBeUndefined();
    }

    // No token smuggled through the query string either.
    expect(String(calledUrl)).not.toMatch(/token|key|secret|bearer|mxk_/i);
  });

  it("asks for the tags in the SAME request as the handles (ac-7)", async () => {
    tagAc(AC(7));

    const spy = vi.fn(async () => okJson([{ handle: "std-1", title: "T", tags: [] }]));
    vi.stubGlobal("fetch", spy);

    await fetchLiveStandards(URL_UNDER_TEST);

    const calledUrl = String((spy.mock.calls[0] as unknown as [string])[0]);
    expect(calledUrl).toContain("type=standard");
    expect(
      calledUrl,
      "`include=tags` is an opt-in on the same list route — omitting it returns rows " +
        "with NO tags key, which fail-open would then read as 'binds every repo' for " +
        "all 51 Standards. Attribution must ride the same call as the handles.",
    ).toContain("include=tags");
    expect(spy, "One call, not two").toHaveBeenCalledTimes(1);
  });

  it("returns the rows verbatim for the planner to validate (ac-7)", async () => {
    tagAc(AC(7));

    const rows = [
      { handle: "std-1", title: "One", tags: [] },
      { handle: "std-44", title: "Two", tags: [{ scope: null, value: "memex-clients" }] },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => okJson(rows)));

    await expect(fetchLiveStandards(URL_UNDER_TEST)).resolves.toEqual(rows);
  });
});

describe("spec-544: a non-200 live response fails loud", () => {
  it("throws on 404 rather than returning nothing (ac-9)", async () => {
    tagAc(AC(9));

    // A Memex flipped to private returns 404 (std-7) — indistinguishable from a
    // renamed one. Returning [] here would hand the planner an empty list, and even
    // though the planner refuses that too, the error must name the HTTP failure so
    // the operator sees the real cause rather than "the list was empty".
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as unknown as Response),
    );

    await expect(fetchLiveStandards(URL_UNDER_TEST)).rejects.toThrow(/404/);
  });

  it("throws on 500 and on a network error (ac-9)", async () => {
    tagAc(AC(9));

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response),
    );
    await expect(fetchLiveStandards(URL_UNDER_TEST)).rejects.toThrow(/500/);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await expect(
      fetchLiveStandards(URL_UNDER_TEST),
      "A network failure must surface, never be swallowed into an empty list.",
    ).rejects.toThrow();
  });
});
