import { describe, it, expect, vi } from "vitest";
import { startCliAuth, pollForToken } from "../lib/auth-flow.js";

function mockResponse({ status = 200, body = {}, text = "" }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => text,
  };
}

describe("startCliAuth", () => {
  it("POSTs to /api/cli/auth/start and returns reqId + code", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        mockResponse({ body: { reqId: "r-1", code: "ABC-123" } })
      );
    const result = await startCliAuth("https://api.test", { fetch: fetchMock });
    expect(result).toEqual({ reqId: "r-1", code: "ABC-123" });
    expect(fetchMock).toHaveBeenCalledWith("https://api.test/api/cli/auth/start", {
      method: "POST",
    });
  });

  it("throws with status + body when start fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockResponse({ status: 500, text: "boom" }));
    await expect(
      startCliAuth("https://api.test", { fetch: fetchMock })
    ).rejects.toThrow(/Failed to start auth \(500\): boom/);
  });
});

describe("pollForToken", () => {
  it("returns the token once status=completed", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ body: { status: "pending" } }))
      .mockResolvedValueOnce(
        mockResponse({ body: { status: "completed", token: "mxt_xyz" } })
      );
    const token = await pollForToken("https://api.test", "r-1", {
      fetch: fetchMock,
      now: () => 0,
      timeoutMs: 10_000,
    });
    expect(token).toBe("mxt_xyz");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws 'Code expired' on 410", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ status: 410 }));
    await expect(
      pollForToken("https://api.test", "r-1", {
        fetch: fetchMock,
        now: () => 0,
        timeoutMs: 10_000,
      })
    ).rejects.toThrow(/Code expired/);
  });

  it("throws 'Code not found' on 404", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ status: 404 }));
    await expect(
      pollForToken("https://api.test", "r-1", {
        fetch: fetchMock,
        now: () => 0,
        timeoutMs: 10_000,
      })
    ).rejects.toThrow(/Code not found/);
  });

  it("throws with status on any other non-OK", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ status: 503 }));
    await expect(
      pollForToken("https://api.test", "r-1", {
        fetch: fetchMock,
        now: () => 0,
        timeoutMs: 10_000,
      })
    ).rejects.toThrow(/Poll failed \(503\)/);
  });

  it("times out when the deadline passes without completion", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockResponse({ body: { status: "pending" } }));
    // Advance the clock past the deadline on the second read so the loop exits.
    let calls = 0;
    const now = () => {
      calls += 1;
      return calls === 1 ? 0 : 999_999;
    };
    await expect(
      pollForToken("https://api.test", "r-1", {
        fetch: fetchMock,
        now,
        timeoutMs: 10_000,
      })
    ).rejects.toThrow(/Timed out/);
  });
});
