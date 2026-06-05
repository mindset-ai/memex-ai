/**
 * Vitest setup module — wires beforeEach / afterEach hooks for AC emission.
 *
 * Import this file for side effects from your `vitest.config.ts`
 * setupFiles:
 *
 *   setupFiles: ['@memex-ai-ac/vitest/setup']
 *
 * Tests opt in by calling `tagAc('<canonical-ac-ref>')` from
 * '@memex-ai-ac/vitest' inside an `it()` / `test()` body. Untagged tests
 * emit nothing.
 */
import { beforeEach, afterEach } from "vitest";
import { _setCurrentTask, _readCurrentEntries, type TaskLike } from "./index.js";
import { emit } from "./emit.js";

beforeEach(({ task }) => {
  _setCurrentTask(task as unknown as TaskLike);
});

afterEach(async ({ task }) => {
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

  await Promise.all(
    entries.map(({ ac_uid, options }) =>
      emit({ ac_uid, status: state, test_identifier, duration_ms, options }),
    ),
  );

  _setCurrentTask(null);
});
