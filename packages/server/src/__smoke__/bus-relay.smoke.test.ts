// Post-deploy smoke — CROSS-INSTANCE BUS RELAY (spec-156 W1 / ac-12, ac-13).
//
// Two tiers, mirroring the rest of the smoke suite (public + authed):
//
//   ac-12 (PUBLIC): GET /api/health surfaces the Postgres LISTEN/NOTIFY relay
//     status. std-17 mandates this smoke assert the relay is actually LISTENing
//     on the deployed env — a relay that booted but never established its
//     dedicated LISTEN connection is a silent single-instance regression (Pulse
//     and cross-tab SSE convergence quietly stop spanning instances). This probe
//     always runs at the deploy tail (no token needed) like the other public
//     checks.
//
//   ac-13 (AUTHED): end-to-end SSE delivery. Open an SSE subscription to the
//     throwaway memex's `/docs/events` stream with the smoke Bearer token, fire
//     a real mutation over /mcp (create_doc), and assert a `doc_change` frame
//     lands on the open stream inside a bounded window. This is the only check
//     that proves the full mutate() → unified bus → (relay) → SSE path end-to-end
//     against the deployed image. It runs single-instance-correct regardless of
//     which Cloud Run instance terminates the SSE vs the /mcp call — the relay is
//     what closes the cross-instance gap, and either way the event must arrive.
//     Skips cleanly when SMOKE_MCP_TOKEN is unset (same gate as the authed tier).
//
// Like the rest of the suite this hits a deployed live host over REAL HTTP and
// is excluded from `make test` (lives behind vitest.smoke.config.ts). Run via
// `make smoke-int` / `make smoke-prod`.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  SMOKE_BASE_URL,
  SMOKE_MCP_TOKEN,
  SMOKE_SESSION_TOKEN,
  SMOKE_NAMESPACE,
  callMcpTool,
  mcpTextPayload,
} from "./smoke-env.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-156/acs";

interface RelayHealthShape {
  listening?: boolean;
  status?: string;
  originId?: string;
  connects?: number;
  reconnects?: number;
  received?: number;
  skippedOwn?: number;
}

describe(`bus-relay smoke @ ${SMOKE_BASE_URL}`, () => {
  // ── ac-12: the relay's LISTEN health is exposed on /api/health and is LIVE.
  it("GET /api/health → relay is attached and LISTENing (spec-156 ac-12)", async () => {
    tagAc(`${AC}/ac-12`);
    tagAc(`${AC}/ac-4`); // scope ac-4: cross-instance guarantee observable on live envs
    const res = await fetch(`${SMOKE_BASE_URL}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status?: string;
      relay?: RelayHealthShape | null;
    };
    expect(body.status).toBe("ok");
    // On a deployed env the relay MUST be attached — `null` means startBusRelay()
    // never ran (single-process boot), which on int/prod is a regression.
    expect(body.relay, "deployed health must carry a relay block").not.toBeNull();
    expect(body.relay).toBeTruthy();
    // The dedicated LISTEN connection must be established — not merely attached.
    expect(body.relay!.listening).toBe(true);
    expect(body.relay!.status).toBe("listening");
    // A per-process origin id must be present so cross-instance dedup works.
    expect(typeof body.relay!.originId).toBe("string");
    expect((body.relay!.originId ?? "").length).toBeGreaterThan(0);
    // At least one successful (re)connect since boot.
    expect(body.relay!.connects ?? 0).toBeGreaterThanOrEqual(1);
  });
});

/** Pull the first `ref: <ref>` token out of an MCP text payload. */
function parseRef(text: string): string | null {
  // Exclude closing punctuation: tool replies often parenthesise the ref —
  // a captured `).` makes the next tool call fail on an invalid ref.
  const m = text.match(/ref:\s*([^\s")]+)/i);
  return m ? m[1] : null;
}

interface SSEStream {
  res: Response;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  buffer: string;
}

/** Open an authed SSE subscription to the throwaway memex's global doc-events
 *  stream and read forward until the server's `ready` frame, so the bus listener
 *  is guaranteed attached before we fire the mutation (no fixed-sleep race). */
async function openMemexStream(memexPath: string, timeoutMs = 10_000): Promise<SSEStream> {
  // Session JWT, NOT the mxt_ token: the SSE routes sit behind
  // sessionMiddleware, which only resolves session JWTs (mxt_ is /mcp-only).
  const res = await fetch(`${SMOKE_BASE_URL}${memexPath}/docs/events`, {
    headers: {
      Authorization: `Bearer ${SMOKE_SESSION_TOKEN}`,
      Accept: "text/event-stream",
    },
  });
  expect(res.status, "SSE stream should open 200").toBe(200);
  const reader = res.body!.getReader();
  const stream: SSEStream = { res, reader, buffer: "" };
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (Date.now() > deadline) throw new Error("SSE: timed out waiting for ready event");
    const { done, value } = await reader.read();
    if (done) throw new Error("SSE: stream closed before ready event");
    stream.buffer += decoder.decode(value, { stream: true });
    const readyIdx = stream.buffer.search(/(^|\n)event: ?ready\b/);
    if (readyIdx >= 0) {
      const after = stream.buffer.indexOf("\n\n", readyIdx);
      if (after >= 0) {
        stream.buffer = stream.buffer.slice(after + 2);
        return stream;
      }
    }
  }
}

/** Read forward on the stream until a `doc_change` frame whose data passes
 *  `match`, or null on timeout. Reuses the shared buffer so prelude bytes from
 *  openMemexStream aren't dropped. */
async function readDocChange(
  stream: SSEStream,
  match: (data: Record<string, unknown>) => boolean,
  timeoutMs = 15_000,
): Promise<Record<string, unknown> | null> {
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  while (true) {
    // Drain any complete frames already buffered.
    let sep = stream.buffer.indexOf("\n\n");
    while (sep >= 0) {
      const frame = stream.buffer.slice(0, sep);
      stream.buffer = stream.buffer.slice(sep + 2);
      const isDocChange = /(^|\n)event: ?doc_change\b/.test(frame);
      if (isDocChange) {
        const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
        if (dataLine) {
          try {
            const data = JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>;
            if (match(data)) return data;
          } catch {
            // Non-JSON data line — ignore and keep reading.
          }
        }
      }
      sep = stream.buffer.indexOf("\n\n");
    }
    if (Date.now() > deadline) return null;
    const { done, value } = await stream.reader.read();
    if (done) return null;
    stream.buffer += decoder.decode(value, { stream: true });
  }
}

describe.skipIf(!SMOKE_MCP_TOKEN || !SMOKE_SESSION_TOKEN)(
  `bus-relay e2e SSE smoke @ ${SMOKE_BASE_URL} (ns=${SMOKE_NAMESPACE})`,
  () => {
    // ── ac-13: a live /mcp mutation lands as a doc_change frame on an open SSE
    //    stream within a bounded window — the full mutate→bus→SSE path, deployed.
    it("MCP mutation arrives as a doc_change SSE frame within a bounded window (spec-156 ac-13)", async () => {
      tagAc(`${AC}/ac-13`);
      tagAc(`${AC}/ac-4`); // scope ac-4: live end-to-end MCP→SSE proof
      tagAc(`${AC}/ac-1`); // scope ac-1: the exact kanban scenario, against the deployed env
      // Guard rail: only ever drive writes against an obvious throwaway namespace.
      if (!/smoke/i.test(SMOKE_NAMESPACE)) {
        throw new Error(
          `Refusing to run bus-relay e2e smoke against namespace "${SMOKE_NAMESPACE}" — ` +
            `it must be an obvious throwaway (contain "smoke"). Set SMOKE_NAMESPACE.`,
        );
      }

      const stamp = new Date().toISOString();
      const title = `[smoke] relay-sse ${stamp}`;
      const purpose = "Bus-relay e2e SSE smoke (spec-156 ac-13) — safe to delete.";

      // The SSE route mounts under /api/<ns>/<mx>; SMOKE_NAMESPACE may be a bare
      // namespace or <ns>/<mx>. Resolve a concrete <ns>/<mx> path from a ref the
      // mutation returns, so the stream is scoped to the same tenant.
      let memexPath: string;
      let createdRef: string | null = null;

      // First create the doc so we have a concrete <ns>/<mx> to scope the stream.
      const created = await callMcpTool("create_doc", {
        memex: SMOKE_NAMESPACE,
        title,
        purpose,
      });
      expect(created.status).toBe(200);
      expect(created.body.result?.isError).toBeFalsy();
      createdRef = parseRef(mcpTextPayload(created.body));
      expect(createdRef, "create_doc should return a canonical ref").toBeTruthy();
      const parts = createdRef!.split("/");
      expect(parts.length).toBeGreaterThanOrEqual(4);
      memexPath = `/api/${parts[0]}/${parts[1]}`;

      // Open the SSE stream (ready-handshake) AFTER we know the tenant path, then
      // fire a fresh mutation and assert it lands. A second mutation (update_doc)
      // is the observed event so we don't race the create we already consumed.
      const stream = await openMemexStream(memexPath);
      try {
        // update_doc accepts status/title/tags — a title rename is the least
        // intrusive mutation that still emits document.updated.
        const updated = await callMcpTool("update_doc", {
          ref: createdRef!,
          title: `${title} (relay-sse-marker)`,
        });
        expect(updated.body.result?.isError).toBeFalsy();

        // Assert a doc_change frame for our doc arrives within the bounded window.
        const event = await readDocChange(stream, (data) => {
          // ChangeEvent carries `{entity, action, ...}`. A doc mutation emits
          // entity:"document" (the canonical doc entity in bus.ts). Matching on
          // it proves end-to-end mutate()→bus→SSE delivery for our tenant.
          return data.entity === "document";
        });
        expect(event, "expected a doc_change SSE frame within the window").not.toBeNull();
      } finally {
        // Always release the reader + close the stream so the connection doesn't
        // dangle on the shared host.
        try {
          await stream.reader.cancel();
        } catch {
          /* best-effort */
        }
      }
    });

    // ── ac-1 (scope): repeated MCP mutations ALL arrive on one long-lived SSE
    //    stream. On prod (--max-instances 3, no session affinity) the /mcp
    //    request and the SSE stream routinely land on DIFFERENT instances, so a
    //    multi-round loop exercises the relay's cross-instance hop with high
    //    probability — the single-round test above can get lucky on one warm
    //    instance. Health samples between rounds record the distinct relay
    //    originIds observed, evidencing how many instances served the run.
    it("N consecutive MCP mutations each arrive on the same open SSE stream (spec-156 ac-1 cross-instance)", async () => {
      tagAc(`${AC}/ac-1`);
      if (!/smoke/i.test(SMOKE_NAMESPACE)) {
        throw new Error(
          `Refusing to run bus-relay e2e smoke against namespace "${SMOKE_NAMESPACE}" — ` +
            `it must be an obvious throwaway (contain "smoke"). Set SMOKE_NAMESPACE.`,
        );
      }
      const ROUNDS = 4;
      const stamp = new Date().toISOString();

      const created = await callMcpTool("create_doc", {
        memex: SMOKE_NAMESPACE,
        title: `[smoke] relay-sse-multi ${stamp}`,
        purpose: "Bus-relay multi-round SSE smoke (spec-156 ac-1) — safe to delete.",
      });
      expect(created.status).toBe(200);
      expect(created.body.result?.isError).toBeFalsy();
      const ref = parseRef(mcpTextPayload(created.body));
      expect(ref, "create_doc should return a canonical ref").toBeTruthy();
      const parts = ref!.split("/");
      const memexPath = `/api/${parts[0]}/${parts[1]}`;

      const origins = new Set<string>();
      const sampleOrigin = async () => {
        try {
          const res = await fetch(`${SMOKE_BASE_URL}/api/health`);
          const body = (await res.json()) as { relay?: RelayHealthShape | null };
          if (body.relay?.originId) origins.add(body.relay.originId);
        } catch {
          /* sampling is best-effort */
        }
      };

      const stream = await openMemexStream(memexPath);
      try {
        for (let round = 1; round <= ROUNDS; round++) {
          await sampleOrigin();
          const updated = await callMcpTool("update_doc", {
            ref: ref!,
            title: `[smoke] relay-sse-multi ${stamp} r${round}/${ROUNDS}`,
          });
          expect(updated.body.result?.isError, `round ${round}: update_doc should succeed`).toBeFalsy();
          // One update_doc → one document event (origin dedup is pinned by the
          // unit/integration tiers, so frame-per-round matching is sound here).
          const event = await readDocChange(stream, (data) => data.entity === "document");
          expect(event, `round ${round}/${ROUNDS}: expected a doc_change SSE frame`).not.toBeNull();
        }
      } finally {
        try {
          await stream.reader.cancel();
        } catch {
          /* best-effort */
        }
      }
      await sampleOrigin();
      // Purely informational — int may legitimately run a single instance.
      // eslint-disable-next-line no-console
      console.log(
        `[bus-relay smoke] ${ROUNDS}/${ROUNDS} rounds delivered; distinct relay originIds observed: ${origins.size}`,
      );
    });
  },
);
