import { useEffect } from 'react';
import {
  deriveDocumentTitle,
  type DocumentTitleInput,
} from '../utils/documentTitle';

// spec-318 t-11 (ac-17): the single place that writes `document.title`. Pages
// don't poke `document.title` directly — they call this hook (PageHeader does it
// for every breadcrumb page; the Spec page does it with the handle-first form).
// Keeping it in one effect-bearing hook means there's exactly one writer and the
// derivation stays a pure, tested function.
export function useDocumentTitle(input: DocumentTitleInput): void {
  const next = deriveDocumentTitle(input);
  useEffect(() => {
    if (next) document.title = next;
  }, [next]);
}
