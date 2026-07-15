// spec-482 (t-7) — a light, user-scoped read of whether the user reads as
// MCP-connected via OBSERVED TRAFFIC: milestones.mcpToolCalled (dec-5, the
// signal a sibling task repointed onboarding to). The post-creation Spec landing
// uses it to (a) gate the grounding line — once the user has real MCP traffic the
// "connect a coding agent" nudge is noise (ac-22 / ac-20) — and (b) morph the
// post-creation handoff card past its connect step.
//
// Fetches the journey state once on mount (and on window focus, mirroring
// useJourneyGraduated) and reduces it to the single boolean. Returns `false`
// until the first read resolves, so the not-connected surface is what shows
// before the answer is known (preserving the existing grounding-line default).
// Advisory — a failed fetch leaves the last known value.
import { useEffect, useState } from 'react';
import { fetchJourneyStateApi } from '../api/journey';

export function useMcpToolCalled(enabled = true): boolean {
  const [mcpToolCalled, setMcpToolCalled] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = () =>
      fetchJourneyStateApi()
        .then((s) => {
          if (alive) setMcpToolCalled(!!s.milestones?.mcpToolCalled);
        })
        .catch(() => {
          /* advisory — the grounding/handoff gate is non-essential; keep last value */
        });
    load();
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => {
      alive = false;
      window.removeEventListener('focus', onFocus);
    };
  }, [enabled]);

  return mcpToolCalled;
}
