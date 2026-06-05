// Device-flow orchestration: claim a request code, poll for the minted token. Both the
// fetch impl and the deadline clock are injectable so tests can drive every branch
// without real network or sleep calls.

export const POLL_TIMEOUT_MS = 5 * 60 * 1000;

export async function startCliAuth(apiBase, deps = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  const res = await fetchImpl(`${apiBase}/api/cli/auth/start`, {
    method: "POST",
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to start auth (${res.status}): ${body}`);
  }
  return res.json();
}

// Polls until the server returns `{ status: "completed", token }`. 404/410 are terminal
// (expired / unknown request). `now` is injectable so tests can drive the timeout cleanly.
export async function pollForToken(apiBase, reqId, deps = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? POLL_TIMEOUT_MS;
  const deadline = now() + timeoutMs;

  while (now() < deadline) {
    const res = await fetchImpl(`${apiBase}/api/cli/auth/poll/${reqId}`);
    if (res.status === 410) {
      throw new Error("Code expired. Re-run the installer.");
    }
    if (res.status === 404) {
      throw new Error("Code not found. Re-run the installer.");
    }
    if (!res.ok) {
      throw new Error(`Poll failed (${res.status})`);
    }
    const body = await res.json();
    if (body.status === "completed" && body.token) return body.token;
  }
  throw new Error("Timed out waiting for authorization. Re-run the installer.");
}
