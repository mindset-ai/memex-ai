// spec-507 ac-6 / ac-15 — nothing is left half-removed.
//
// The risk with a subtraction this wide is a dangling remnant: a fixture that
// suppresses a gate that no longer exists, a helper with no callers, a registered
// event with no emitter. Those don't fail a type-check (they're strings and dead
// exports), so this source-level scan is the guard. It reads the actual e2e
// helper/setup files and asserts the retired scaffolding is gone.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tagAc } from '@memex-ai-ac/vitest';

const AC_NO_DEAD_FIXTURE = 'mindset-prod/memex-building-itself/specs/spec-507/acs/ac-15';
const AC_NO_HALF_REMOVAL = 'mindset-prod/memex-building-itself/specs/spec-507/acs/ac-6';

const UI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(join(UI_ROOT, rel), 'utf8');

describe('spec-507 ac-15: no test fixture suppresses a gate that no longer exists', () => {
  it('the e2e fixtures no longer pre-stamp video_welcomed_at or seed the dismiss flag', () => {
    tagAc(AC_NO_DEAD_FIXTURE);
    const fixtures = read('e2e/helpers/fixtures.ts');
    expect(fixtures).not.toContain('setVideoWelcomed');
    expect(fixtures).not.toContain("sessionStorage.setItem('welcomeVideoDismissed'");
    // The dismiss helper is gone (only the tombstone comment may mention the name).
    expect(fixtures).not.toContain('export async function dismissWelcomeVideo');
  });

  it('global-setup no longer pre-stamps the dev user as welcomed', () => {
    tagAc(AC_NO_DEAD_FIXTURE);
    const setup = read('e2e/global-setup.ts');
    expect(setup).not.toContain('setVideoWelcomed');
  });

  it('the setVideoWelcomed seed helper is gone', () => {
    tagAc(AC_NO_DEAD_FIXTURE);
    expect(read('e2e/helpers/seed.ts')).not.toContain('export async function setVideoWelcomed');
  });

  it('the three gate journeys (53-video / 54-ctas / 55-play-button) are deleted', () => {
    tagAc(AC_NO_DEAD_FIXTURE);
    expect(existsSync(join(UI_ROOT, 'e2e/journey-53-spec-444-welcome-video.spec.ts'))).toBe(false);
    expect(existsSync(join(UI_ROOT, 'e2e/journey-54-spec-460-welcome-ctas.spec.ts'))).toBe(false);
    expect(existsSync(join(UI_ROOT, 'e2e/journey-55-spec-462-welcome-play-button.spec.ts'))).toBe(false);
  });
});

describe('spec-507 ac-6: no dead client function or gate helper survives', () => {
  it('dismissWelcomeVideoApi is removed from the auth client', () => {
    tagAc(AC_NO_HALF_REMOVAL);
    expect(read('src/api/auth.ts')).not.toContain('export async function dismissWelcomeVideoApi');
  });

  it('the router no longer imports getCachedJourneyState for a gate that is gone', () => {
    tagAc(AC_NO_HALF_REMOVAL);
    // The gate was the only consumer of the cached journey state in App.tsx.
    expect(read('src/App.tsx')).not.toContain('getCachedJourneyState');
  });
});
