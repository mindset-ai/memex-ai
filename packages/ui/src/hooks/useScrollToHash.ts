// spec-304 t-59 (issue-25): scroll a deep-linked `#section` into view on first
// navigation. A single-page app does NOT honour a URL hash the way a full page
// load does — navigating to `/settings/integrations#desktop-mcp` (e.g. from the
// native MCP pill or tray item) lands on the page but never scrolls, so the user
// had to click a second time. This hook scrolls the hash target into view once
// it exists, retrying across a few frames because the target often mounts AFTER
// the route change. No-op when there is no hash.

import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

/** Max animation frames to wait for the hash target to mount before giving up. */
const MAX_FRAMES = 30;

export function useScrollToHash(): void {
  const { hash } = useLocation();

  useEffect(() => {
    if (!hash) return;
    const id = decodeURIComponent(hash.slice(1));
    if (!id) return;

    let frame = 0;
    let tries = 0;
    const tryScroll = () => {
      const el = document.getElementById(id);
      if (el) {
        // `scroll-margin-top` on the target (set by the section) keeps the
        // heading off the very top edge.
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      // The target usually mounts just after the route change — retry a few
      // frames before giving up rather than missing it on first render.
      if (tries++ < MAX_FRAMES) frame = requestAnimationFrame(tryScroll);
    };
    tryScroll();

    return () => {
      if (frame) cancelAnimationFrame(frame);
    };
  }, [hash]);
}
