// spec-126 dec-8 (ac-18) / spec-159 ac-19 — the viewer's own posture switch.
// Promotes/demotes via the existing `promoteToEditor` / `demoteToReviewer`
// paths (the same SpecRoleControls uses); the resulting `doc_member` bus event
// re-resolves role wherever `useDocRole` is mounted. The local `refetchRole`
// makes the flip immediate rather than waiting on the stream. No new switch
// machinery — this is the proactive surface for the toggle.
//
// History: born as `useSwitchToEditing` (reviewer → editor only, extracted from
// the removed chat opening turn); generalised to both directions when the
// posture moved into the header PostureDropdown. DocDocument is the sole
// consumer.

import { useCallback } from 'react';
import { promoteToEditor, demoteToReviewer, type DocRole } from '../api/client';
import { useDocRole } from './useDocRole';

export function useSwitchPosture(docId: string): (target: DocRole) => Promise<void> {
  const { refetch: refetchRole } = useDocRole(docId);
  return useCallback(
    async (target: DocRole) => {
      try {
        await (target === 'editor' ? promoteToEditor(docId) : demoteToReviewer(docId));
      } catch {
        // Best-effort: a failed switch leaves the viewer's posture unchanged.
        // Never throw out of a click handler.
      }
      refetchRole();
    },
    [docId, refetchRole],
  );
}
