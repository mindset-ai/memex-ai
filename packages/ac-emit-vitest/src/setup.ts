/**
 * Vitest setup module — wires beforeEach / afterEach / afterAll hooks for AC emission.
 *
 * Import this file for side effects from your `vitest.config.ts`
 * setupFiles:
 *
 *   setupFiles: ['@memex-ai-ac/vitest/setup']
 *
 * Tests opt in by calling `tagAc('<canonical-ac-ref>')` from
 * '@memex-ai-ac/vitest' inside an `it()` / `test()` body. Untagged tests
 * emit nothing.
 *
 * spec-489 G1 — emissions are BATCHED. `afterEach` buffers each tagged test's
 * result instead of POSTing it; a top-level `afterAll` flushes the whole file's
 * buffer as ONE batch request (`emitBatch`). A suite that tags N tests then
 * makes ~one request per test FILE rather than N per-test POSTs — the
 * connection-pool relief the CI-burst report asked for. This changes only the
 * transport (how events travel), never their meaning: every buffered event is
 * still emitted, exactly once, with the same wire payload. No consumer config
 * changes — the same `setupFiles` import wires it.
 */
import { beforeEach, afterEach, afterAll } from "vitest";
import {
  _setCurrentTask,
  _readCurrentEntries,
  type TaskLike,
} from "./index.js";
import { emitBatch, capturedFetch } from "./emit.js";
import type { TagAcOptions } from "./types.js";

interface BufferedEmission {
  ac_uid: string;
  status: "pass" | "fail";
  test_identifier: string;
  duration_ms: number;
  options?: TagAcOptions;
}

// The file's pending emissions, buffered by afterEach and drained by afterAll.
// Module-scoped, so it holds exactly the emissions of the test file this setup
// module was evaluated for; the afterAll drain (splice) makes it robust even if
// a runner shares the module across files — each flush sends only what has
// accumulated since the previous flush.
const pending: BufferedEmission[] = [];

beforeEach(({ task }) => {
  _setCurrentTask(task as unknown as TaskLike);
});

afterEach(({ task }) => {
  const taskLike = task as unknown as TaskLike;
  const entries = _readCurrentEntries(taskLike);
  if (entries.length === 0) {
    _setCurrentTask(null);
    return;
  }

  const state = task.result?.state;
  if (state !== "pass" && state !== "fail") {
    _setCurrentTask(null);
    return;
  }

  const test_identifier = `${task.file?.name ?? "<unknown>"}::${task.name}`;
  const duration_ms = task.result?.duration ?? 0;

  // Buffer (don't POST) — a test tagged with K ACs contributes K events, exactly
  // as before; only the flush is deferred to the end of the file.
  for (const { ac_uid, options } of entries) {
    pending.push({ ac_uid, status: state, test_identifier, duration_ms, options });
  }

  _setCurrentTask(null);
});

afterAll(async () => {
  if (pending.length === 0) return;
  // Drain so a second flush (shared-module runner) can't re-send these events.
  const batch = pending.splice(0, pending.length);
  // Flush through the module-load-captured fetch (spec-302): immune to any test
  // that replaced globalThis.fetch and didn't restore it. emitBatch honours the
  // fail-safe contract (swallows non-2xx + network/timeout), so a flush can
  // never fail the run.
  await emitBatch(batch, capturedFetch);
});
