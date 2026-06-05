// spec-103 t-4: resolve the current tenant's Org scaffold additions so a live
// Prompt Button can compose them.
//
// The Prompt Button on a surface (e.g. DocDocument's verify-spec button) needs
// the enabled Org appends for its button so `toButtonPrompt` can splice the
// Org's guidance into the copied prompt. This hook mirrors the fetch pattern in
// ScaffoldInspect: resolve the Org via `getOrgApi`, then load the merged
// scaffold via `fetchScaffold`, and hand back the Org GuidanceBlock array.
//
// Resolving the Org can fail (personal Memex, namespace with no ownerOrgId,
// non-member) — that's NON-FATAL: the hook falls back to an empty array, which
// `toButtonPrompt` treats as "no Org appends". The whole array is returned;
// `toButtonPrompt` filters it by `target.button`, so callers don't pre-filter.

import { useEffect, useState } from 'react';
import { useAuth } from '../components/AuthContext';
import { getOrgApi } from '../api/client';
import { fetchScaffold } from '../api/scaffold';
import type { GuidanceBlock } from '@memex/shared';

/**
 * Returns the enabled Org scaffold additions (GuidanceBlocks) for the current
 * tenant's Org, or [] on any failure. Re-resolves when the auth token changes.
 */
export function useOrgScaffoldBlocks(): readonly GuidanceBlock[] {
  const { token } = useAuth();
  const [blocks, setBlocks] = useState<readonly GuidanceBlock[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const org = await getOrgApi(token);
        if (cancelled) return;
        const payload = await fetchScaffold(org.id);
        if (cancelled) return;
        setBlocks(payload.org);
      } catch {
        // Non-fatal: personal Memex / non-member / no Org overlay. Fall back to
        // no Org appends so the live button still composes the base prompt.
        if (cancelled) return;
        setBlocks([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  return blocks;
}
