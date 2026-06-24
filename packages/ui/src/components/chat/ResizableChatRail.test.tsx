// spec-389 t-1 (dec-1): the shared drag-resizable chat rail. Pins that the rail
// docks its children, exposes a resize handle, and persists its width under the
// per-surface storage key (ac-1 shared affordance, ac-5 single-sourced).

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { ResizableChatRail } from './ResizableChatRail';

const AC_VISUAL = 'mindset-prod/memex-building-itself/specs/spec-389/acs/ac-1';
const AC_SINGLE_SOURCED =
  'mindset-prod/memex-building-itself/specs/spec-389/acs/ac-5';

beforeEach(() => {
  window.localStorage.clear();
});

describe('ResizableChatRail — shared drag-resizable rail (ac-1, ac-5)', () => {
  it('docks its children and renders a resize separator', () => {
    tagAc(AC_VISUAL);
    render(
      <ResizableChatRail
        storageKey="standards-chat-width"
        testId="standards-assistant-panel"
        handleTestId="standards-chat-resize"
      >
        <div>panel content</div>
      </ResizableChatRail>,
    );
    expect(screen.getByTestId('standards-assistant-panel')).toBeInTheDocument();
    expect(screen.getByText('panel content')).toBeInTheDocument();
    const handle = screen.getByTestId('standards-chat-resize');
    expect(handle).toHaveAttribute('role', 'separator');
    expect(handle).toHaveAttribute('aria-orientation', 'vertical');
  });

  it('persists the rail width under the surface-specific storage key', () => {
    tagAc(AC_SINGLE_SOURCED);
    render(
      <ResizableChatRail storageKey="issues-chat-width">
        <div>issues panel</div>
      </ResizableChatRail>,
    );
    // Default width (384) is written on mount under the given key.
    expect(window.localStorage.getItem('issues-chat-width')).toBe('384');
  });

  it('restores a previously-saved, in-range width', () => {
    tagAc(AC_SINGLE_SOURCED);
    window.localStorage.setItem('scaffold-chat-width', '500');
    render(
      <ResizableChatRail storageKey="scaffold-chat-width" testId="rail">
        <div>scaffold panel</div>
      </ResizableChatRail>,
    );
    expect(screen.getByTestId('rail')).toHaveStyle({ width: '500px' });
  });

  it('falls back to the default when the saved width is out of range', () => {
    tagAc(AC_SINGLE_SOURCED);
    window.localStorage.setItem('x-chat-width', '99999');
    render(
      <ResizableChatRail storageKey="x-chat-width" testId="rail2">
        <div>panel</div>
      </ResizableChatRail>,
    );
    expect(screen.getByTestId('rail2')).toHaveStyle({ width: '384px' });
  });
});
