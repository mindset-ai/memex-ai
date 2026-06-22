import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { USAGE_EVENT_REGISTRY, isFrontendEvent } from '@memex/shared';

// UI-side mirror of the shared registry-contract assertions, for AC EMISSION.
// The shared package's unit tests carry the same assertions but run in a CI job
// without MEMEX_EMIT_KEY, so their tagAc() calls no-op — the events never land.
// This file re-asserts the registry facts from the UI job (which DOES emit), so
// ac-5 (machine contract) and ac-3 (Home untouched) actually verify. Importing
// @memex/shared gives the real, built registry (with the spec-338 events).

const AC = 'mindset-prod/memex-building-itself/specs/spec-338/acs';

const NEW_FRONTEND_EVENTS = [
  'auth.login_started',
  'spec.card_opened',
  'spec.tab_viewed',
  'board.phase_drag',
  'board.tag_filter_applied',
  'search.opened',
  'search.query_submitted',
  'search.result_selected',
  'comments.filter_changed',
  'whatsnew.opened',
  'workspace.switched',
  'voice.mic_permission_result',
  'voice.icon_shown',
] as const;

describe('spec-338 registry contract (UI-side, emits ACs)', () => {
  it('the 13 engagement events are registered front-end events (machine contract)', () => {
    tagAc(`${AC}/ac-5`);
    tagAc(`${AC}/ac-1`);
    for (const name of NEW_FRONTEND_EVENTS) {
      expect(isFrontendEvent(name)).toBe(true);
    }
  });

  it('adds no onboarding.* events and leaves home_canvas.* intact (Home untouched — spec-336 owns it)', () => {
    tagAc(`${AC}/ac-3`);
    const names = USAGE_EVENT_REGISTRY.map((e) => e.name);
    expect(names.filter((n) => n.startsWith('onboarding.'))).toHaveLength(0);
    expect(names).toContain('home_canvas.step_shown');
    expect(names).toContain('home_canvas.cta_clicked');
  });
});
