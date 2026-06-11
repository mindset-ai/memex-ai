// spec-222 t-1 (dec-5) — the single-source / app-parity proof.
//
// ac-2  (scope): "one source for the voice loop, Specky, barge-in, VAD, playback
//                 and the client graph, with no fork".
// ac-17 (impl):  "Both packages/ui and the SDK bundle consume the voice engine
//                 from a single packages/guide-sdk — there is no duplicated
//                 orchestrator / graph / Specky source — and the existing
//                 spec-190/197 voice tests pass with the engine sourced from
//                 guide-sdk (app parity, no regression)."
//
// This file asserts the STRUCTURAL half: the engine source lives ONLY in
// guide-sdk, the app no longer holds a duplicate copy, and packages/ui consumes
// it via the workspace dependency. The BEHAVIOURAL half (parity / no regression)
// is evidenced by the full pre-existing voice suite passing unchanged — the moved
// engine tests (guide-sdk) plus the app suite (packages/ui), both green.

import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AC_PARITY = 'mindset-prod/memex-building-itself/specs/spec-222/acs/ac-2';
const AC_SINGLE_SOURCE = 'mindset-prod/memex-building-itself/specs/spec-222/acs/ac-17';

const here = dirname(fileURLToPath(import.meta.url)); // .../guide-sdk/src/__extraction__
const sdkSrc = resolve(here, '..'); // .../guide-sdk/src
const repoRoot = resolve(here, '..', '..', '..', '..'); // worktree root
const uiSrc = resolve(repoRoot, 'packages', 'ui', 'src');

/** Engine pieces ac-2/ac-17 name explicitly — the loop, Specky, barge-in, VAD,
 *  playback, the client graph. Each must live in guide-sdk and NOT in ui. */
const ENGINE = [
  { sdk: 'orchestrator/voiceGuideOrchestrator.ts', ui: 'voice/orchestrator/voiceGuideOrchestrator.ts' },
  { sdk: 'guideGraph.ts', ui: 'voice/guideGraph.ts' },
  { sdk: 'bargeIn.ts', ui: 'voice/bargeIn.ts' },
  { sdk: 'micVad.ts', ui: 'voice/micVad.ts' },
  { sdk: 'playbackQueue.ts', ui: 'voice/playbackQueue.ts' },
  { sdk: 'guideTools.ts', ui: 'voice/guideTools.ts' },
  { sdk: 'components/Specky.tsx', ui: 'components/Specky.tsx' },
];

describe('spec-222 t-1: single source, no fork (ac-2 / ac-17)', () => {
  it('every named engine piece lives in guide-sdk', () => {
    tagAc(AC_SINGLE_SOURCE);
    tagAc(AC_PARITY);
    for (const { sdk } of ENGINE) {
      expect(existsSync(resolve(sdkSrc, sdk)), `${sdk} must exist in guide-sdk`).toBe(true);
    }
  });

  it('no duplicate engine source remains in packages/ui (no fork)', () => {
    tagAc(AC_SINGLE_SOURCE);
    tagAc(AC_PARITY);
    for (const { ui } of ENGINE) {
      expect(existsSync(resolve(uiSrc, ui)), `${ui} must NOT exist in ui (moved, not copied)`).toBe(false);
    }
  });

  it('packages/ui consumes the engine via the @memex/guide-sdk workspace dependency', () => {
    tagAc(AC_SINGLE_SOURCE);
    const uiPkg = JSON.parse(readFileSync(resolve(repoRoot, 'packages', 'ui', 'package.json'), 'utf8'));
    expect(uiPkg.dependencies?.['@memex/guide-sdk']).toBeTruthy();
  });
});
