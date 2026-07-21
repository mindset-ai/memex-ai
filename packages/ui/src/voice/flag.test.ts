import { describe, it, expect } from 'vitest';
import type { SessionPayload } from '../api/client';
import { VOICE_GUIDE_FLAG, isVoiceGuideHidden } from './flag';

function sessionWithHidden(hidden: string[]): SessionPayload {
  return { hiddenFeatures: hidden } as unknown as SessionPayload;
}

describe('voice-guide (Specky) kill-switch', () => {
  it('shows Specky by default (fail-open — no slug set)', () => {
    expect(isVoiceGuideHidden(sessionWithHidden([]))).toBe(false);
    expect(isVoiceGuideHidden(null)).toBe(false);
  });

  it('hides Specky when the kill-switch slug is present (config flip, no redeploy)', () => {
    expect(isVoiceGuideHidden(sessionWithHidden([VOICE_GUIDE_FLAG]))).toBe(true);
  });

  it('is unaffected by unrelated hidden slugs', () => {
    expect(isVoiceGuideHidden(sessionWithHidden(['home', 'scaffold', 'onboarding-wizard']))).toBe(false);
  });

  it('uses a single, stable slug string', () => {
    expect(VOICE_GUIDE_FLAG).toBe('voice-guide');
  });
});
