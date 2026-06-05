import type { TagAcOptions } from "./types.js";

export type { AcEventPayload, TagAcOptions } from "./types.js";
export { readAutoActor } from "./actor.js";
export { deriveEventsUrl } from "./derive-url.js";
export { isEmissionEnabled, isHidden, readEmissionKey, buildPayload, emit } from "./emit.js";
export { buildMetadata } from "./metadata.js";

const META_KEY = "__memex_ac_uids";

export interface TaskMetaEntry {
  ac_uid: string;
  options?: TagAcOptions;
}

export interface TaskLike {
  meta: Record<string, unknown>;
}

let currentTask: TaskLike | null = null;

/** Internal — set by setup.ts beforeEach. */
export function _setCurrentTask(task: TaskLike | null): void {
  currentTask = task;
}

/** Internal — read the entries collected on a task. */
export function _readCurrentEntries(task: TaskLike): TaskMetaEntry[] {
  return (task.meta[META_KEY] as TaskMetaEntry[] | undefined) ?? [];
}

/**
 * Tag the current test with an AC reference.
 *
 * Call from inside an `it()` / `test()` body. Can be called multiple times
 * to associate the test with multiple ACs.
 *
 * If called outside a test body (e.g. at module load or inside
 * `describe()`), the call is a no-op — there's no task to attach to.
 *
 * @param ac_uid Canonical AC ref: `<namespace>/<memex>/specs/<spec-N>/acs/ac-<N>`
 * @param options Per-call overrides for hidden and metadata
 */
export function tagAc(ac_uid: string, options?: TagAcOptions): void {
  if (!currentTask) return;
  const existing = _readCurrentEntries(currentTask);
  currentTask.meta[META_KEY] = [...existing, { ac_uid, options }];
}
