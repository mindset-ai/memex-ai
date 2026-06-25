// spec-372 — the onboarding funnel telemetry registry (dec-6). The 3-layer model is only
// computable if every name it uses is registered (compile-checked + server-accepted) and the
// per-step success signals exist in usage_events.
//   ac-24 — every onboarding event name is registered with a description.
//   ac-23 — each step has a success signal (existing milestone events + the new ac.created).
//   ac-20 — drop-off (step_shown spine) + success rate are computable from registered events.
import { describe, it, expect } from 'vitest';
import { USAGE_EVENT_REGISTRY, BACKEND_EVENT_NAMES, isRegisteredEvent } from '@memex/shared';
import { tagAc } from '@memex-ai-ac/vitest';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-372/acs/ac-${n}`;

function entry(name: string) {
  return USAGE_EVENT_REGISTRY.find((e) => e.name === name);
}

describe('spec-372 onboarding funnel telemetry registry', () => {
  it('ac-24: every onboarding event name is registered and described', () => {
    tagAc(AC(24));
    for (const name of [
      'home_canvas.step_shown',
      'home_canvas.cta_clicked',
      'home_canvas.persona_selected',
    ]) {
      expect(isRegisteredEvent(name)).toBe(true);
      expect(entry(name)?.description?.length ?? 0).toBeGreaterThan(0);
    }
    // The expanded cta enum (Layer C) is documented on cta_clicked so the discriminators
    // are an allow-listed, low-cardinality set (no PII/content).
    const ctaDesc = entry('home_canvas.cta_clicked')?.description ?? '';
    for (const cta of [
      'copy_install',
      'copy_create_prompt',
      'copy_explore_prompt',
      'docs_link',
      'connect_target',
      'create_method',
      'starting_point',
      'copy_prompt',
    ]) {
      expect(ctaDesc).toContain(cta);
    }
    // persona is recorded as the resolved label, never raw coordinates.
    expect(entry('home_canvas.persona_selected')?.description ?? '').toMatch(/never.*coordinates/i);
  });

  it('ac-23: each onboarding step has a success signal registered in usage_events', () => {
    tagAc(AC(23));
    // identity → persona_selected (fires on profile-save success); create-spec → document.created;
    // resolve-decision → decision.resolved; add-ac → ac.created (NEW); plus mcp.connected /
    // account.created cover the connect / signup milestones.
    for (const name of [
      'home_canvas.persona_selected',
      'document.created',
      'decision.resolved',
      'ac.created',
      'mcp.connected',
      'account.created',
    ]) {
      expect(isRegisteredEvent(name)).toBe(true);
    }
    // ac.created must ride the bus → usage_events sink (whitelisted), so it actually records.
    expect(BACKEND_EVENT_NAMES).toContain('ac.created');
  });

  it('ac-20: drop-off (step_shown spine) and success-rate events are both registered', () => {
    tagAc(AC(20));
    // Drop-off spine.
    expect(isRegisteredEvent('home_canvas.step_shown')).toBe(true);
    // Success numerators (a representative milestone per step) — presence makes
    // success-rate = milestone ÷ step_shown computable in Mixpanel + backstage.
    for (const name of ['document.created', 'decision.resolved', 'ac.created']) {
      expect(isRegisteredEvent(name)).toBe(true);
    }
  });
});
