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

const AC26 = 'mindset-prod/memex-building-itself/specs/spec-190/acs/ac-26';
const AC28 = 'mindset-prod/memex-building-itself/specs/spec-190/acs/ac-28';
// Scope ACs (t-9 sweep): ac-3 = the guide can visually highlight the part of the
// screen it's talking about; ac-4 = on request it navigates to the right section.
const AC3 = 'mindset-prod/memex-building-itself/specs/spec-190/acs/ac-3';
const AC4 = 'mindset-prod/memex-building-itself/specs/spec-190/acs/ac-4';
// spec-206 t-2: the orchestrator-commandable advance.
const AC206_8 = 'mindset-prod/memex-building-itself/specs/spec-206/acs/ac-8';

function ctx(navigate = vi.fn()): NavigateContext {
  return { namespace: 'acme', memex: 'team', navigate };
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
  it('navigates to a registered navigable screen via the app router', () => {
    const navigate = vi.fn();
    const r = executeNavigate({ screen: 'standards-list' }, ctx(navigate));
    expect(r).toEqual({ ok: true, path: '/acme/team/standards' });
    expect(navigate).toHaveBeenCalledWith('/acme/team/standards');
    tagAc(AC4); // scope: on request, navigate to the right section
  });

  it('rejects an unregistered / detail-only destination WITHOUT calling the router', () => {
    const navigate = vi.fn();
    expect(executeNavigate({ screen: 'spec-detail' }, ctx(navigate)).ok).toBe(false); // needs an entity id
    expect(executeNavigate({ screen: 'not-a-screen' }, ctx(navigate)).ok).toBe(false);
    expect(executeNavigate({}, ctx(navigate)).ok).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    tagAc(AC26);
  });
});

describe('dispatchGuideUiTool — client toolset guard (ac-28)', () => {
  it('routes highlight + navigate, and refuses any other (incl. product-data) tool', () => {
    document.body.innerHTML = '<button data-guide-id="new-spec-button">x</button>';
    const navigate = vi.fn();
    expect(dispatchGuideUiTool('highlight', { elementId: 'new-spec-button' }, ctx(navigate)).ok).toBe(true);
    expect(dispatchGuideUiTool('navigate', { screen: 'specs-list' }, ctx(navigate)).ok).toBe(true);

    // The guide never client-executes a data tool — these are not UI tools.
    for (const name of ['search_memex', 'get_doc', 'list_docs', 'update_section']) {
      const r = dispatchGuideUiTool(name, { anything: true }, ctx(navigate));
      expect(r.ok).toBe(false);
    }
    expect(navigate).toHaveBeenCalledTimes(1); // only the legit navigate fired
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
});
