import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import type { SessionPayload } from '../api/client';
import {
  ONBOARDING_WIZARD_FLAG,
  isOnboardingWizardEnabled,
} from './flag';

// spec-502 dec-5:
//   ac-6  — the wizard is reversible.
//   ac-14 — reversibility is a single kill-switch flag; disabling it falls back
//           without a code change (a config flip of HIDDEN_FEATURES).
const AC_REVERSIBLE = 'mindset-prod/memex-building-itself/specs/spec-502/acs/ac-6';
const AC_KILLSWITCH = 'mindset-prod/memex-building-itself/specs/spec-502/acs/ac-14';

function sessionWithHidden(hidden: string[]): SessionPayload {
  return { hiddenFeatures: hidden } as unknown as SessionPayload;
}

describe('spec-502 ac-6/ac-14: onboarding-wizard kill-switch', () => {
  it('is enabled by default (fail-open — no slug set)', () => {
    tagAc(AC_REVERSIBLE);
    tagAc(AC_KILLSWITCH);
    expect(isOnboardingWizardEnabled(sessionWithHidden([]))).toBe(true);
    expect(isOnboardingWizardEnabled(null)).toBe(true);
  });

  it('is disabled when the kill-switch slug is present (config flip, no redeploy)', () => {
    tagAc(AC_KILLSWITCH);
    expect(isOnboardingWizardEnabled(sessionWithHidden([ONBOARDING_WIZARD_FLAG]))).toBe(false);
  });

  it('is unaffected by unrelated hidden slugs', () => {
    tagAc(AC_KILLSWITCH);
    expect(isOnboardingWizardEnabled(sessionWithHidden(['home', 'scaffold', 'pulse']))).toBe(true);
  });

  it('uses a single, stable slug string', () => {
    tagAc(AC_REVERSIBLE);
    expect(ONBOARDING_WIZARD_FLAG).toBe('onboarding-wizard');
  });
});
