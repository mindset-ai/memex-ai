// spec-318 t-11 (ac-17): central derivation of `document.title`. The desktop
// Flutter shell (spec-318) reads `document.title` to label each tab chip; a
// narrow chip truncates from the RIGHT, so the Spec page leads with its handle
// (`spec-N`) — the unique id has to survive the clip. Every other page derives
// from the title it already hands to PageHeader.
//
// The string is produced FULL and un-truncated here; clipping is the consumer's
// render concern (the tab chip), never ours.

export type DocumentTitleInput =
  | { kind: 'spec'; handle: string; name: string }
  | { kind: 'page'; title: string };

/**
 * Resolve the `document.title` for the active page.
 *
 * - Spec page → `spec-N · <name>` (handle FIRST). When the Spec has no name
 *   yet, falls back to the bare handle.
 * - Any other page → its trimmed PageHeader title.
 *
 * Returns `null` when there's nothing meaningful to set (e.g. an empty page
 * title) so the caller can leave the current title untouched rather than
 * blanking it.
 */
export function deriveDocumentTitle(input: DocumentTitleInput): string | null {
  if (input.kind === 'spec') {
    const handle = input.handle.trim();
    const name = input.name.trim();
    return name ? `${handle} · ${name}` : handle || null;
  }
  const title = input.title.trim();
  return title || null;
}
