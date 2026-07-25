// spec-502 t-3 (dec-7, ac-17): the Explore companion's context detector.
//
// As the user clicks around inside a Memex, the companion needs to know WHAT they
// are currently looking at. That is a pure function of the URL: the tenant route
// grammar (std-10 cl-2) is `/:ns/:mx/<surface>[/<handle>...]`, so the in-view
// entity is derivable from the pathname alone — no data fetch, no global store.
//
// `entityFromPath` is that pure mapping (unit-testable by feeding pathnames).
// `useExploreContext` is the thin react-router wrapper that re-computes on every
// navigation — which is the ONLY trigger for the companion to re-render its
// synopsis (ac-17: reactive, not a click-next tour).

import { useLocation } from 'react-router-dom';
import type { SynopsisEntity } from './synopsis';

/** Strip query + hash, split into non-empty path segments. */
function segmentsOf(pathname: string): string[] {
  return pathname.split('?')[0].split('#')[0].split('/').filter(Boolean);
}

/**
 * Map a tenant pathname to the entity the user is looking at. Pure + deterministic.
 * Segments: [0]=namespace, [1]=memex, [2]=surface, [3]=handle, ...
 *
 * Portable (std-22): it reads the generic tenant route grammar, hardcoding no
 * specific namespace/memex — the same mapping holds for any Memex a user explores.
 */
export function entityFromPath(pathname: string): SynopsisEntity {
  const segs = segmentsOf(pathname);
  const surface = segs[2];
  const handle = segs[3];

  // Index (the whole-vault graph) or the /home redirect target.
  if (!surface) return { kind: 'trail' };

  switch (surface) {
    // ── whole-vault graph + overview ──
    case 'home':
      return { kind: 'home' };
    case 'trails':
      return { kind: 'trail' };

    // ── list boards that don't carry a per-item handle in the URL ──
    case 'decisions':
      return { kind: 'decisions-board' };
    case 'issues':
      // /issues is the roll-up board; a single issue only exists under a Spec.
      return { kind: 'issues-board' };

    // ── tool / analytics / config surfaces (the screen IS the subject) ──
    case 'pulse':
      return { kind: 'pulse' };
    case 'insights':
      return { kind: 'insights' };
    case 'qa-reports':
      return { kind: 'qa-reports' };
    case 'drift':
      return { kind: 'drift' };
    case 'scaffold':
      return { kind: 'scaffold' };
    case 'keys':
      return { kind: 'keys' };
    case 'settings':
      return { kind: 'settings' };
    case 'org':
      return { kind: 'org' };

    // ── board ⇄ detail surfaces: no handle = the board; handle = the item ──
    case 'standards':
      return handle ? { kind: 'standard', handle } : { kind: 'standards-board' };
    case 'docs':
      return handle ? { kind: 'doc', handle } : { kind: 'docs-board' };
    case 'skills':
      return handle ? { kind: 'skill', handle } : { kind: 'skills-board' };

    case 'specs': {
      if (!handle) return { kind: 'specs-board' };
      if (handle === 'tags') return { kind: 'tags' };
      // Deep-links hang off a Spec: specs/:id/decisions/:decId, specs/:id/issues/:issueId.
      const sub = segs[4];
      if (sub === 'decisions' && segs[5]) return { kind: 'decision', handle: segs[5] };
      if (sub === 'issues' && segs[5]) return { kind: 'issue', handle: segs[5] };
      return { kind: 'spec', handle };
    }

    // Genuinely unrecognised surface — the companion falls back to a generic line.
    default:
      return { kind: 'unknown' };
  }
}

/**
 * The in-view entity for the current route. Re-derived on every navigation, so the
 * companion reacts to what the user clicks with no explicit "next" step (ac-17).
 */
export function useExploreContext(): SynopsisEntity {
  const { pathname } = useLocation();
  return entityFromPath(pathname);
}
