import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import { useScrollToHash } from './useScrollToHash';

// issue-25 → t-59: deep-linking to #desktop-mcp (from the pill / tray) must
// scroll the section into view on FIRST navigation, not require a second click.
const AC_SCROLL =
  'mindset-prod/memex-building-itself/specs/spec-304/acs/ac-54';

function Harness({ withTarget }: { withTarget: boolean }) {
  useScrollToHash();
  return withTarget ? <section id="desktop-mcp">MCP</section> : null;
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('spec-304 ac-54 (issue-25): deep-linked hash scrolls into view on first nav', () => {
  it('scrolls the #hash target into view when the route carries a hash', async () => {
    tagAc(AC_SCROLL);
    const scrollIntoView = vi.fn();
    // jsdom does not implement scrollIntoView — install a spy on the prototype.
    Element.prototype.scrollIntoView = scrollIntoView;

    render(
      <MemoryRouter initialEntries={['/settings/integrations#desktop-mcp']}>
        <Harness withTarget />
      </MemoryRouter>,
    );

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
  });

  it('does nothing when there is no hash (no spurious scroll)', async () => {
    tagAc(AC_SCROLL);
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    render(
      <MemoryRouter initialEntries={['/settings/integrations']}>
        <Harness withTarget />
      </MemoryRouter>,
    );

    // Give any retry frames a chance to fire, then assert nothing scrolled.
    await new Promise((r) => setTimeout(r, 50));
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
