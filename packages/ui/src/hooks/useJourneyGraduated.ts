// spec-372 dec-8 / t-11 — a light, user-scoped read of whether the onboarding journey is
// graduated, for the AppShell "come back to onboarding" nav dot. Fetches the journey state
// once on mount (and refetches on window focus, mirroring HomeCanvas) and reduces it through
// the shared isJourneyGraduated seam.
//
// Returns `boolean | null`: null while the first read is in flight (so the caller can avoid
// flashing the dot before the answer is known). Advisory — a failed fetch leaves it null.
import { useEffect, useState } from 'react';
import { fetchJourneyStateApi } from '../api/journey';
import { isJourneyGraduated } from '../journeys/graduation';

export function useJourneyGraduated(enabled = true): boolean | null {
  const [graduated, setGraduated] = useState<boolean | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = () =>
      fetchJourneyStateApi()
        .then((s) => {
          if (alive) setGraduated(isJourneyGraduated(s));
        })
        .catch(() => {
          /* advisory — the nudge is non-essential; leave the last known value */
        });
    load();
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => {
      alive = false;
      window.removeEventListener('focus', onFocus);
    };
  }, [enabled]);

  return graduated;
}
