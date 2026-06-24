// spec-389 t-1 (dec-1): the shared drag-resizable chat rail. Extracted from the
// scaffold-inspect surface (spec-360) into ONE reusable component so every
// surface that docks an in-app agent (scaffold, standards, issues) gets the same
// drag-resizable rail (ac-1/ac-5) instead of a copy per page. Width is clamped
// and persisted under a per-surface storage key. Desktop only (`hidden md:flex`).

import { useCallback, useEffect, useState, type ReactNode } from 'react';

const CHAT_MIN_W = 300;
const CHAT_MAX_W = 720;
const CHAT_DEFAULT_W = 384; // = the old fixed w-96

export interface ResizableChatRailProps {
  /** Per-surface localStorage key, e.g. 'scaffold-chat-width', 'standards-chat-width'. */
  storageKey: string;
  /** The chat panel (or any rail content) to dock. */
  children: ReactNode;
  /** Optional testid on the rail container (e.g. 'standards-assistant-panel'). */
  testId?: string;
  /** Optional testid on the drag handle. */
  handleTestId?: string;
}

export function ResizableChatRail({
  storageKey,
  children,
  testId,
  handleTestId,
}: ResizableChatRailProps) {
  const [chatWidth, setChatWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return CHAT_DEFAULT_W;
    const saved = Number(window.localStorage.getItem(storageKey));
    return Number.isFinite(saved) && saved >= CHAT_MIN_W && saved <= CHAT_MAX_W
      ? saved
      : CHAT_DEFAULT_W;
  });

  useEffect(() => {
    window.localStorage.setItem(storageKey, String(chatWidth));
  }, [storageKey, chatWidth]);

  const startChatResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = chatWidth;
      const onMove = (ev: MouseEvent) => {
        const next = Math.min(
          CHAT_MAX_W,
          Math.max(CHAT_MIN_W, startW + ev.clientX - startX),
        );
        setChatWidth(next);
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
      };
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [chatWidth],
  );

  return (
    <aside
      data-testid={testId}
      style={{ width: chatWidth }}
      className="relative hidden md:flex shrink-0 flex-col min-h-0 border-r border-default"
    >
      <div className="flex-1 min-h-0">{children}</div>
      {/* Drag handle — resize the chat rail. Sits over the right border with a
          wider hit area; highlights on hover/drag. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize chat panel"
        data-testid={handleTestId}
        onMouseDown={startChatResize}
        className="absolute top-0 -right-1 z-10 h-full w-2 cursor-col-resize transition-colors hover:bg-accent/40"
      />
    </aside>
  );
}
