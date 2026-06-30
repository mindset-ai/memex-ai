import type { TagAcOptions } from "./types.js";

export type { AcEventPayload, TagAcOptions } from "./types.js";
export { readAutoActor } from "./actor.js";
export { deriveEventsUrl } from "./derive-url.js";
export { isEmissionEnabled, readEmissionKey, buildPayload, emit } from "./emit.js";
export { buildMetadata } from "./metadata.js";

const META_KEY = "__memex_ac_uids";

export interface TaskMetaEntry {
  ac_uid: string;
  options?: TagAcOptions;
}

export interface TaskLike {
  meta: Record<string, unknown>;
}

// The current-task slot lives on globalThis, NOT in module-local state.
//
// Why (spec-156, discovered 2026-06-05): inside the monorepo this package can
// be instantiated TWICE in one vitest worker — setupFiles resolves
// `@memex-ai-ac/vitest/setup` through Node's `default` condition (dist/), while
// test files' bare `import { tagAc }` resolves through the `development`
// condition (src/, added in spec-129 issue-1's stale-dist fix). With a
// module-local `currentTask`, the setup hooks set the slot on the dist
// instance and every tagAc call in the src instance saw `null` — silently
// no-opping ALL emissions, local and CI alike. A globalThis slot is shared by
// every instance regardless of how the consumer's resolver split them.
const TASK_SLOT = Symbol.for("memex-ai-ac.currentTask");

function readTaskSlot(): TaskLike | null {
  return ((globalThis as Record<symbol, unknown>)[TASK_SLOT] as TaskLike | null) ?? null;
}

/** Internal — set by setup.ts beforeEach. */
export function _setCurrentTask(task: TaskLike | null): void {
  (globalThis as Record<symbol, unknown>)[TASK_SLOT] = task;
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
 * @param options Per-call overrides for metadata
 */
export function tagAc(ac_uid: string, options?: TagAcOptions): void {
  const currentTask = readTaskSlot();
  if (!currentTask) return;
  const existing = _readCurrentEntries(currentTask);
  currentTask.meta[META_KEY] = [...existing, { ac_uid, options }];
}

/**
 * Tag the current test with a standard-CLAUSE reference (spec-151 dec-1).
 *
 * A clause ref and an AC ref are both just canonical refs naming a *verifiable
 * subject*; the emit pipeline routes purely on the ref's namespace prefix
 * (`deriveEventsUrl`) and stores the ref verbatim, so a clause attestation rides
 * the SAME shared emitter as an AC attestation — there is no parallel pipeline.
 * This is the thin sibling that dec-1 settled on: it forwards to `tagAc`, which
 * is the single collection point feeding `emit()`.
 *
 * Use it inside an `it()` / `test()` body to attest that a standard clause holds.
 * Because a clause is *universal* (it must hold everywhere it applies, unlike an
 * existential AC), pass the swept surface and check-kind via `options.metadata`
 * (e.g. `{ clause_surface, clause_kind }`) so the coverage view can tell a
 * whole-surface scan from a spot check.
 *
 * @param clause_ref Canonical clause ref: `<namespace>/<memex>/standards/<std-N>/clauses/cl-<N>`
 * @param options Per-call overrides for metadata
 */
export function tagClause(clause_ref: string, options?: TagAcOptions): void {
  tagAc(clause_ref, options);
}
