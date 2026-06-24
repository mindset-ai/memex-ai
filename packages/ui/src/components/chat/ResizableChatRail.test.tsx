// spec-389 t-1 (dec-1): the shared drag-resizable chat rail. Pins that the rail
// docks its children, exposes a resize handle, and persists its width under the
// per-surface storage key (ac-1 shared affordance, ac-5 single-sourced).

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { tagAc } from '@memex-ai-ac/vitest';
import { ResizableChatRail } from './ResizableChatRail';
import { useChatCollapse } from './ChatCollapseContext';

// A stand-in for ChatPanel: surfaces the rail-provided collapse handler so the
// test can drive the collapse exactly as the real header button does.
function CollapseTrigger() {
  const { onCollapse } = useChatCollapse();
  return (
    <button data-testid="trigger-collapse" onClick={onCollapse}>
      collapse
    </button>
  );
}

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

describe('ResizableChatRail — collapse to a strip (spec-389)', () => {
  it('collapses to the strip on the panel handler, then reopens — both persisted', async () => {
    tagAc(AC_VISUAL);
    const user = userEvent.setup();
    render(
      <ResizableChatRail storageKey="standards-chat-width" testId="rail" label="Standards">
        <CollapseTrigger />
      </ResizableChatRail>,
    );
    // Expanded: the docked child is live, no strip.
    expect(screen.getByTestId('trigger-collapse')).toBeInTheDocument();
    expect(screen.queryByTestId('rail-collapsed')).not.toBeInTheDocument();

    // Collapse → the child is gone, the strip is shown, and it's persisted.
    await user.click(screen.getByTestId('trigger-collapse'));
    expect(screen.queryByTestId('trigger-collapse')).not.toBeInTheDocument();
    expect(screen.getByTestId('rail-collapsed')).toBeInTheDocument();
    expect(window.localStorage.getItem('standards-chat-width:collapsed')).toBe('1');

    // Click the strip → reopened, persisted off.
    await user.click(screen.getByTestId('rail-collapsed'));
    expect(screen.getByTestId('trigger-collapse')).toBeInTheDocument();
    expect(window.localStorage.getItem('standards-chat-width:collapsed')).toBe('0');
  });

  it('starts collapsed when persisted, labelled per surface', () => {
    tagAc(AC_VISUAL);
    window.localStorage.setItem('issues-chat-width:collapsed', '1');
    render(
      <ResizableChatRail storageKey="issues-chat-width" testId="rail" label="Issues">
        <CollapseTrigger />
      </ResizableChatRail>,
    );
    expect(screen.queryByTestId('trigger-collapse')).not.toBeInTheDocument();
    expect(screen.getByTestId('rail-collapsed')).toHaveAccessibleName(/Issues/);
  });
});
