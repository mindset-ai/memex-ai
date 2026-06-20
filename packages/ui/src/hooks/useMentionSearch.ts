import { useEffect, useRef, useState } from 'react';
import { searchMentionableMembers, type MentionableMember } from '../api/client';

const DEBOUNCE_MS = 150;

// spec-320 (dec-4): the shared, debounced data source for the @-mention typeahead.
// Given the active `@`-token's query (or null when the caret isn't in a token),
// returns the matching ACTIVE org members (substring on name / email). A null query
// clears the results; stale responses are dropped via a sequence guard. Used by
// both the inline section comment composer (CommentComposerPopover) and the
// discussion-tray composer (MentionComposer) so there is ONE search implementation.
export function useMentionSearch(query: string | null): MentionableMember[] {
  const [results, setResults] = useState<MentionableMember[]>([]);
  const seqRef = useRef(0);

  useEffect(() => {
    if (query === null) {
      setResults([]);
      return;
    }
    const seq = ++seqRef.current;
    const handle = window.setTimeout(async () => {
      const members = await searchMentionableMembers(query);
      if (seqRef.current === seq) setResults(members);
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [query]);

  return results;
}
