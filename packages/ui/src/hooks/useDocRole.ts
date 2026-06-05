// spec-118 t-6 — the viewer's posture on a Spec (editor vs reviewer) + the Spec's
// editors. Drives the reviewer/editor UI mode. Posture resolution is role-blind on
// the read path (dec-2): every member reads the Spec; this only decides capability.
//
// Self-contained fetch + refetch; also subscribes to the doc change stream so a
// promotion/demotion by a teammate (a 'doc_member' bus event, std-8) updates the
// viewer's posture live.

import { useCallback, useEffect, useState } from 'react';
import { fetchDocRole, type DocRole, type DocEditor } from '../api/client';
import { useDocChangeStream } from './useDocChangeStream';

export interface UseDocRole {
  myRole: DocRole;
  editors: DocEditor[];
  loading: boolean;
  refetch: () => void;
}

export function useDocRole(docId: string | null): UseDocRole {
  const [myRole, setMyRole] = useState<DocRole>('reviewer');
  const [editors, setEditors] = useState<DocEditor[]>([]);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(() => {
    if (!docId) return;
    fetchDocRole(docId)
      .then((state) => {
        setMyRole(state.myRole);
        setEditors(state.editors);
      })
      .catch(() => {
        // A failed role fetch must not break the page — default to the safe
        // reviewer posture (read-only-ish) rather than throwing.
        setMyRole('reviewer');
      })
      .finally(() => setLoading(false));
  }, [docId]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  // Live posture: refetch when the doc's change stream fires (covers a teammate
  // promoting/demoting this viewer). Debounced inside the hook.
  useDocChangeStream(docId, refetch);

  return { myRole, editors, loading, refetch };
}
