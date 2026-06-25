// spec-222 t-6 (dec-5) — the SDK core ships ONLY the reusable engine. App-only
// features (first-run greeting spec-206, demo walkthrough spec-211, What's New
// spec-200) are NOT in the bundle; the walkthrough client tools activate only
// when the host enables the `walkthrough` capability. (ac-6, ac-18)

import { describe, it, expect, vi } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  dispatchGuideUiTool,
  activeClientToolNames,
  CORE_CLIENT_TOOL_NAMES,
  type NavigationAdapter,
} from '../index';

const AC_6 = 'mindset-prod/memex-building-itself/specs/spec-222/acs/ac-6';
const AC_18 = 'mindset-prod/memex-building-itself/specs/spec-222/acs/ac-18';

const here = dirname(fileURLToPath(import.meta.url));
const SDK_SRC = resolve(here, '..');

const noopAdapter: NavigationAdapter = {
  resolveScreenKey: () => null,
  currentScreenKey: () => null,
  navigate: () => ({ ok: false, reason: 'n/a' }),
  findElement: () => null,
};

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'dist') continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...walkFiles(full));
    else if (/\.(ts|tsx)$/.test(e)) out.push(full);
  }
  return out;
}

describe('spec-222 t-6: SDK core is engine-only; walkthrough is capability-gated', () => {
  it('the walkthrough client tools are INERT without the capability (website posture) — ac-18', () => {
    tagAc(AC_18);
    const advanceDemo = vi.fn();
    const startWalkthrough = vi.fn();
    // No capabilities (the website): advance_demo / start_walkthrough refuse and
    // the wired callbacks are NEVER invoked.
    const websiteCtx = { adapter: noopAdapter, advanceDemo, startWalkthrough };
    expect(dispatchGuideUiTool('advance_demo', {}, websiteCtx).ok).toBe(false);
    expect(dispatchGuideUiTool('start_walkthrough', {}, websiteCtx).ok).toBe(false);
    expect(advanceDemo).not.toHaveBeenCalled();
    expect(startWalkthrough).not.toHaveBeenCalled();

    // With the capability (the Memex app): they activate.
    const appCtx = { adapter: noopAdapter, capabilities: { walkthrough: true }, advanceDemo, startWalkthrough };
    expect(dispatchGuideUiTool('advance_demo', {}, appCtx).ok).toBe(true);
    expect(dispatchGuideUiTool('start_walkthrough', {}, appCtx).ok).toBe(true);
    expect(advanceDemo).toHaveBeenCalledTimes(1);
    expect(startWalkthrough).toHaveBeenCalledTimes(1);
  });

  it('the active client toolset is core-only without the capability, app-extended with it — ac-18', () => {
    tagAc(AC_18);
    expect([...activeClientToolNames()].sort()).toEqual(['highlight', 'navigate']);
    expect([...activeClientToolNames({})].sort()).toEqual(['highlight', 'navigate']);
    const withWalk = activeClientToolNames({ walkthrough: true });
    expect(withWalk.has('advance_demo')).toBe(true);
    expect(withWalk.has('start_walkthrough')).toBe(true);
    // Core tools are always present.
    expect(CORE_CLIENT_TOOL_NAMES.has('highlight')).toBe(true);
    expect(CORE_CLIENT_TOOL_NAMES.has('navigate')).toBe(true);
  });

  it('no app-only feature code (greeting / walkthrough sequencer / whats-new) lives in the SDK core — ac-6', () => {
    tagAc(AC_6);
    tagAc(AC_18);
    // The SDK core must not import or contain the spec-206/211/200 feature modules
    // — they stay app-side (packages/ui) and merely CONFIGURE the engine.
    const forbidden = [
      /FirstRunGreeting/, // spec-206 first-run greeting
      /walkthrough\//, // spec-211 demo-walkthrough sequencer/controller
      /DemoWalkthroughController/,
      /demoWalkthrough/,
      /whats-new/i, // spec-200 What's New
      /WhatsNew/,
    ];
    const offenders: Record<string, string[]> = {};
    for (const file of walkFiles(SDK_SRC)) {
      if (/\.test\.(ts|tsx)$/.test(file)) continue; // this guard names them as data
      const text = readFileSync(file, 'utf8');
      const hits = forbidden.filter((re) => re.test(text)).map(String);
      if (hits.length) offenders[relative(SDK_SRC, file)] = hits;
    }
    expect(offenders).toEqual({});
  });
});
