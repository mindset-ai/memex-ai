// t-5 client-side guide tool execution (dec-4 / ac-26 / ac-28). highlight via the
// DOM resolver, navigate validated before any router call, and the dispatch
// guard that refuses anything but highlight/navigate.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import {
  executeHighlight,
  executeNavigate,
  dispatchGuideUiTool,
  type NavigateContext,
} from './guideTools';
import type { NavigationAdapter, NavigateOutcome } from './navigation/NavigationAdapter';

const AC26 = 'mindset-prod/memex-building-itself/specs/spec-190/acs/ac-26';
const AC28 = 'mindset-prod/memex-building-itself/specs/spec-190/acs/ac-28';
// Scope ACs (t-9 sweep): ac-3 = the guide can visually highlight the part of the
// screen it's talking about; ac-4 = on request it navigates to the right section.
const AC3 = 'mindset-prod/memex-building-itself/specs/spec-190/acs/ac-3';
const AC4 = 'mindset-prod/memex-building-itself/specs/spec-190/acs/ac-4';
// spec-206 t-2: the orchestrator-commandable advance.
const AC206_8 = 'mindset-prod/memex-building-itself/specs/spec-206/acs/ac-8';

// spec-222 (ac-9): the engine no longer resolves screen→path itself — the injected
// NavigationAdapter owns validate-then-navigate and returns the NavigateOutcome.
// This fake stands in for the app's react-router-backed adapter: it maps the same
// known screens (mirroring the old screenKeyToPath behaviour) and records the
// SCREEN keys it was asked to navigate to, so we can assert delegation.
const KNOWN_PATHS: Record<string, string> = {
  'standards-list': '/acme/team/standards',
  'specs-list': '/acme/team/specs',
};

function fakeAdapter(): NavigationAdapter & { navigated: string[] } {
  const navigated: string[] = [];
  return {
    navigated,
    resolveScreenKey: () => null,
    currentScreenKey: () => null,
    findElement: (id) => document.querySelector<HTMLElement>(`[data-guide-id="${id}"]`),
    navigate(screen: string): NavigateOutcome {
      navigated.push(screen);
      const path = KNOWN_PATHS[screen];
      // Unregistered / detail-only (entity-requiring) screens are rejected WITHOUT
      // navigating — the adapter owns this, preserving the old ac-26 contract.
      return path ? { ok: true, path } : { ok: false, reason: 'not a navigable screen' };
    },
  };
}

function ctx(adapter: NavigationAdapter = fakeAdapter()): NavigateContext {
  return { adapter };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('executeHighlight (ac-26)', () => {
  it('flashes the highlight class on the resolved element', () => {
    document.body.innerHTML = '<button data-guide-id="new-spec-button">+ New Spec</button>';
    const node = document.querySelector('[data-guide-id="new-spec-button"]')!;
    const r = executeHighlight({ elementId: 'new-spec-button' });
    expect(r.ok).toBe(true);
    expect(node.classList.contains('guide-highlight')).toBe(true);
    tagAc(AC3); // scope: visually highlight the element it's talking about
  });

  it('is a no-op (never throws) when the element is not rendered or id missing', () => {
    document.body.innerHTML = '<div>nothing</div>';
    expect(executeHighlight({ elementId: 'phase-pill' }).ok).toBe(false);
    expect(executeHighlight({}).ok).toBe(false);
  });
});

describe('executeNavigate (ac-26)', () => {
  it('delegates a registered navigable screen to the adapter and returns its outcome', () => {
    const adapter = fakeAdapter();
    const r = executeNavigate({ screen: 'standards-list' }, ctx(adapter));
    // The engine returns whatever the adapter resolves — it no longer owns the path.
    expect(r).toEqual({ ok: true, path: '/acme/team/standards' });
    expect(adapter.navigated).toContain('standards-list'); // delegated, by screen key
    tagAc(AC4); // scope: on request, navigate to the right section
  });

  it('rejects an unregistered / detail-only destination (adapter refuses to navigate)', () => {
    const adapter = fakeAdapter();
    expect(executeNavigate({ screen: 'spec-detail' }, ctx(adapter)).ok).toBe(false); // needs an entity id
    expect(executeNavigate({ screen: 'not-a-screen' }, ctx(adapter)).ok).toBe(false);
    // A missing screen short-circuits in the engine — the adapter is NOT consulted.
    expect(executeNavigate({}, ctx(adapter)).ok).toBe(false);
    // The two unnavigable screens reached the adapter (which refused); the empty
    // input did not (engine guard) — so no successful navigation ever happened.
    expect(adapter.navigated).toEqual(['spec-detail', 'not-a-screen']);
    tagAc(AC26);
  });
});

describe('dispatchGuideUiTool — client toolset guard (ac-28)', () => {
  it('routes highlight + navigate, and refuses any other (incl. product-data) tool', () => {
    document.body.innerHTML = '<button data-guide-id="new-spec-button">x</button>';
    const adapter = fakeAdapter();
    const c = ctx(adapter);
    expect(dispatchGuideUiTool('highlight', { elementId: 'new-spec-button' }, c).ok).toBe(true);
    expect(dispatchGuideUiTool('navigate', { screen: 'specs-list' }, c).ok).toBe(true);

    // The guide never client-executes a data tool — these are not UI tools.
    for (const name of ['search_memex', 'get_doc', 'list_docs', 'update_section']) {
      const r = dispatchGuideUiTool(name, { anything: true }, c);
      expect(r.ok).toBe(false);
    }
    expect(adapter.navigated).toEqual(['specs-list']); // only the legit navigate reached the adapter
    tagAc(AC28);
  });

  it('routes advance_demo to the wired advance callback (spec-206 ac-8)', () => {
    const advanceDemo = vi.fn();
    const r = dispatchGuideUiTool('advance_demo', {}, { ...ctx(), advanceDemo });
    expect(r.ok).toBe(true);
    expect(advanceDemo).toHaveBeenCalledTimes(1);
    tagAc(AC206_8);
  });

  it('advance_demo is a no-op (never throws) when no advance callback is wired', () => {
    // ctx() has no advanceDemo — degrade gracefully rather than throw.
    expect(dispatchGuideUiTool('advance_demo', {}, ctx()).ok).toBe(false);
  });

  it('routes start_walkthrough to the wired sequencer trigger (spec-211 t-3)', () => {
    const startWalkthrough = vi.fn();
    expect(dispatchGuideUiTool('start_walkthrough', {}, { ...ctx(), startWalkthrough }).ok).toBe(true);
    expect(startWalkthrough).toHaveBeenCalledTimes(1);
    // No-op (never throws) when nothing is wired.
    expect(dispatchGuideUiTool('start_walkthrough', {}, ctx()).ok).toBe(false);
  });
});
