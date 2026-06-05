// spec-156 (2026-06-05): the current-task slot must be shared across MODULE
// INSTANCES of this package. In the monorepo, a consumer's setupFiles can
// resolve the `default` export condition (dist/) while its test files resolve
// the `development` condition (src/) — two live instances in one worker. With
// a module-local slot, the setup hooks populated one instance and tagAc
// silently no-opped on the other, killing every AC emission (local AND CI).
// The slot now lives on globalThis (Symbol.for), so any instance combination
// shares it. This test simulates the split with vi.resetModules().
import { describe, it, expect, vi } from "vitest";

describe("current-task slot survives module-instance duality (spec-156)", () => {
  it("a second instance's tagAc sees the task set by the first instance", async () => {
    const instanceA = await import("./index.js");
    vi.resetModules();
    const instanceB = await import("./index.js");
    // Genuinely two instances — same source, distinct module copies.
    expect(instanceB.tagAc).not.toBe(instanceA.tagAc);

    const fakeTask = { meta: {} as Record<string, unknown> };
    try {
      instanceA._setCurrentTask(fakeTask);
      // The OTHER instance must observe the slot and attach the entry.
      instanceB.tagAc("probe://dual-instance", { hidden: true });
      const entries = (fakeTask.meta.__memex_ac_uids as unknown[] | undefined) ?? [];
      expect(entries).toHaveLength(1);
    } finally {
      // Restore the slot so the real afterEach/beforeEach hooks are unaffected.
      instanceA._setCurrentTask(null);
    }
  });
});
