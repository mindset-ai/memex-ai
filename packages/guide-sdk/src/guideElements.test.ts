// t-4 runtime binding (dec-3 / ac-16): the highlight tool resolves a registry id
// to the live DOM node via data-guide-id (findGuideElement).
//
// spec-222 (ac-9): the engine-owned half of this test is the pure DOM resolver.
// The screen-key resolution (currentScreenKey → resolveScreenKey) and the UI
// data-guide-id consistency scan moved with their `@memex/shared` coupling to the
// app's `voice/reactRouterNavigationAdapter.test.ts` (same assertions + AC16 tag).

import { describe, it, expect, afterEach } from 'vitest';
import { findGuideElement } from './guideElements';

describe('findGuideElement (ac-16 — id → live DOM node)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('resolves a registry id to the node carrying its data-guide-id', () => {
    document.body.innerHTML =
      '<div><button data-guide-id="new-spec-button">+ New Spec</button></div>';
    const node = findGuideElement('new-spec-button');
    expect(node).not.toBeNull();
    expect(node?.tagName).toBe('BUTTON');
  });

  it('returns null when the element is not currently rendered', () => {
    document.body.innerHTML = '<div>no targets here</div>';
    expect(findGuideElement('phase-pill')).toBeNull();
  });
});
