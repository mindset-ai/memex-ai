import { useEffect, useRef, useState } from 'react';
import { searchMentionableMembers, type MentionableMember } from '../api/client';

const DEBOUNCE_MS = 150;

export type MentionSearchStatus = 'idle' | 'loading' | 'done';

export interface MentionSearchState {
  results: MentionableMember[];
  /** 'idle' = no active token; 'loading' = a search is in flight; 'done' = the
   *  latest query has resolved (so an empty `results` here means "genuinely no one
   *  to mention", which the composer surfaces as an empty-state rather than silence). */
  status: MentionSearchStatus;
}

// spec-320 (dec-4): the shared, debounced data source for the @-mention typeahead.
// Given the active `@`-token's query (or null when the caret isn't in a token),
// returns the matching ACTIVE org members (substring on name / email) plus a status
// so the composer can tell "still searching" from "searched, found no one". A null
// query resets to idle; stale responses are dropped via a sequence guard. Used by
// both the inline section composer (CommentComposerPopover) and the discussion-tray
// composer (MentionComposer) so there is ONE search implementation.
export function useMentionSearch(query: string | null): MentionSearchState {
  const [state, setState] = useState<MentionSearchState>({ results: [], status: 'idle' });
  const seqRef = useRef(0);

  useEffect(() => {
    if (query === null) {
      setState({ results: [], status: 'idle' });
      return;
    }
    const seq = ++seqRef.current;
    // Keep the previous results on screen while the next query resolves (no flicker),
    // but mark the box as loading so an empty result doesn't flash "no one" early.
    setState((s) => ({ results: s.results, status: 'loading' }));
    const handle = window.setTimeout(async () => {
      const members = await searchMentionableMembers(query);
      if (seqRef.current === seq) setState({ results: members, status: 'done' });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [query]);

  return state;
}
