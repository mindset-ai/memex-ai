import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Command } from 'cmdk';
import {
  searchMemexApi,
  type SearchEnvelope,
  type SearchHit,
  type SearchHitKind,
} from '../api/client';
import { snippetText } from '../utils/format';
import { Badge } from './ui';

// spec-64 t-3/t-4: the global command-palette omnibox.
//
// Structure (top → bottom): a cmdk Dialog (Radix → role=dialog, owns Esc-to-
// close + focus restoration, ac-8) wrapping a controlled Command.Input + a
// Command.List that renders THREE tiers in order — Jump to (jumpTo lane) →
// Assigned (assigned lane, only when non-empty) → In content (content lane,
// grouped by entity kind). cmdk's List is a role=listbox and each Item a
// role=option with aria-selected on the active row (ac-15); cmdk also provides
// the single roving arrow-key selection across every tier/group (ac-10).
//
// The ⌘K hotkey is NOT owned here — App.tsx's app-level keydown listener toggles
// `open` (ac-16). This component only reacts to the `open`/`onOpenChange` props.
//
// Search runs against GET /api/<ns>/<mx>/search via searchMemexApi; the input is
// debounced ~150ms (ac-9). `shouldFilter={false}` because the SERVER already
// ranked + filtered every lane — cmdk must render exactly what we hand it, in
// order, and only drive selection/keyboard nav. When results are FTS-only there
// is NO degraded banner — the lanes render identically (ac-12).

const DEBOUNCE_MS = 150;
const SNIPPET_MAX = 120;

// spec-64 t-4 (ac-9): the content lane is grouped under entity-kind headers, in
// this fixed order. Each header label is the plural display name.
const CONTENT_KIND_ORDER: ReadonlyArray<SearchHitKind> = [
  'spec',
  'standard',
  'document',
  'decision',
  'issue',
];

const KIND_LABEL: Record<SearchHitKind, string> = {
  spec: 'Spec',
  standard: 'Standard',
  document: 'Document',
  decision: 'Decision',
  issue: 'Issue',
};

const KIND_GROUP_HEADING: Record<SearchHitKind, string> = {
  spec: 'Specs',
  standard: 'Standards',
  document: 'Documents',
  decision: 'Decisions',
  issue: 'Issues',
};

const EMPTY_ENVELOPE: SearchEnvelope = { jumpTo: [], assigned: [], content: [] };

// spec-64 t-8 (ac-22): the tier/kind group headings must read as clear SEPARATORS
// between sections, not the faint inline labels they were (small, text-muted, no
// rule). Each heading now gets a full-width divider rule above it (matching the
// input's border-edge), extra top spacing, and bold, higher-contrast,
// wider-tracked uppercase text. Applied to EVERY Command.Group so the tiers
// (Jump to / Assigned) and the in-content kind groups (Specs / Standards / …)
// separate consistently. Written as full literal class strings so Tailwind's
// JIT scanner picks up the arbitrary-variant classes.
const GROUP_CLASS =
  '[&_[cmdk-group-heading]]:mt-1 [&_[cmdk-group-heading]]:border-t [&_[cmdk-group-heading]]:border-edge ' +
  '[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:pb-2 ' +
  '[&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-bold [&_[cmdk-group-heading]]:uppercase ' +
  '[&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-secondary';

export interface SearchPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Derive the entity's handle(s) from its canonical path (std-10 grammar): the
// segments matching spec-N / std-N / doc-N / dec-N / issue-N. A doc hit yields one
// handle ("spec-12"); a decision/issue hit yields parent + own joined with a
// slash ("spec-12/dec-3") so the row is unambiguous without the full path.
const HANDLE_SEGMENT = /^(?:spec|std|doc|dec|issue)-\d+$/;

function handleFromPath(path: string): string {
  return path.split('/').filter((seg) => HANDLE_SEGMENT.test(seg)).join('/');
}

// spec-64 t-4 (ac-9): every row carries a kind badge + a status badge. The kind
// badge reuses the neutral Badge styling with an explicit label so it reads
// "Spec" / "Standard" / … rather than a status colour.
function HitBadges({ hit }: { hit: SearchHit }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      <Badge status="neutral" label={KIND_LABEL[hit.kind]} />
      <Badge status={hit.status} />
    </span>
  );
}

// One result row. Navigation rows (jumpTo / assigned) render NO snippet; content
// rows render ONE plain-text snippet from matchingSections[0].content (ac-20).
// `value` must be unique across the whole list (cmdk dedupes by value), so it's
// prefixed with the lane — the same path can appear in both jumpTo and content.
function ResultRow({
  hit,
  lane,
  onPick,
}: {
  hit: SearchHit;
  lane: 'jumpTo' | 'assigned' | 'content';
  onPick: (hit: SearchHit) => void;
}) {
  const snippet =
    lane === 'content' && hit.matchingSections.length > 0
      ? snippetText(hit.matchingSections[0].content, SNIPPET_MAX)
      : null;

  // The handle (spec-N / std-N / …) renders next to the title so the user can
  // tell WHICH spec a row is without opening it — titles alone are ambiguous.
  const handle = handleFromPath(hit.path);

  return (
    <Command.Item
      // Unique, stable value per row. Keeps cmdk's dedupe + roving selection
      // honest when the same `path` surfaces in more than one lane.
      value={`${lane}:${hit.path}`}
      // Disable cmdk's text-scoring against this value (it's a synthetic key,
      // not user-facing text) — selection still works, ordering stays ours.
      keywords={[]}
      onSelect={() => onPick(hit)}
      className="flex cursor-pointer flex-col gap-1 rounded-md px-3 py-2 text-sm aria-selected:bg-selected"
      data-testid="search-result"
      data-kind={hit.kind}
      data-path={hit.path}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-baseline gap-2">
          {handle && (
            <span
              className="shrink-0 font-mono text-xs text-muted"
              data-testid="search-handle"
            >
              {handle}
            </span>
          )}
          <span className="truncate text-primary">{hit.title}</span>
        </span>
        <HitBadges hit={hit} />
      </span>
      {snippet && (
        <span className="truncate text-xs text-secondary" data-testid="search-snippet">
          {snippet}
        </span>
      )}
    </Command.Item>
  );
}

export function SearchPalette({ open, onOpenChange }: SearchPaletteProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchEnvelope>(EMPTY_ENVELOPE);
  const [loading, setLoading] = useState(false);

  // Reset the input + results whenever the palette is (re)opened so a stale
  // query/result set never flashes on the next open.
  useEffect(() => {
    if (open) {
      setQuery('');
      setResults(EMPTY_ENVELOPE);
      setLoading(false);
    }
  }, [open]);

  // spec-64 t-4 (ac-9): debounce the query ~150ms, then fetch the envelope. An
  // AbortController cancels the in-flight request when a newer keystroke arrives
  // (or the palette closes), so out-of-order responses can't clobber the latest.
  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setResults(EMPTY_ENVELOPE);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      searchMemexApi(trimmed, { signal: controller.signal })
        .then((envelope) => {
          if (!controller.signal.aborted) {
            setResults(envelope);
            setLoading(false);
          }
        })
        .catch((err) => {
          // AbortError is the expected outcome of a superseded query — swallow
          // it. Any other failure leaves the prior results and clears loading.
          if ((err as Error)?.name !== 'AbortError') {
            setResults(EMPTY_ENVELOPE);
            setLoading(false);
          }
        });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, open]);

  // spec-64 t-4 (ac-10): Enter (or click) navigates to the focused hit's
  // canonical path via react-router. `path` has no leading slash, so prefix one
  // — the admin routes mount specs at /:namespace/:memex/specs/... (App.tsx), and
  // `path` is already `<ns>/<mx>/specs/spec-N`, so `/` + path lands on-route.
  const handlePick = useCallback(
    (hit: SearchHit) => {
      onOpenChange(false);
      navigate('/' + hit.path);
    },
    [navigate, onOpenChange],
  );

  const { jumpTo, assigned, content } = results;
  const hasQuery = query.trim().length > 0;

  // Bucket the content lane by kind, preserving the server's per-kind ordering.
  const contentByKind = useRef<Record<SearchHitKind, SearchHit[]>>(
    {} as Record<SearchHitKind, SearchHit[]>,
  );
  contentByKind.current = CONTENT_KIND_ORDER.reduce(
    (acc, kind) => {
      acc[kind] = content.filter((h) => h.kind === kind);
      return acc;
    },
    {} as Record<SearchHitKind, SearchHit[]>,
  );

  const hasAnyResult =
    jumpTo.length > 0 || assigned.length > 0 || content.length > 0;

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Search this memex"
      shouldFilter={false}
      loop
      overlayClassName="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
      contentClassName="fixed left-1/2 top-[15vh] z-50 w-full max-w-xl -translate-x-1/2 overflow-hidden rounded-xl border border-edge bg-panel shadow-2xl"
    >
      <Command.Input
        value={query}
        onValueChange={setQuery}
        placeholder="Search specs, standards, documents, decisions, issues…"
        className="w-full border-b border-edge bg-transparent px-4 py-3 text-sm text-primary outline-none placeholder:text-muted"
      />
      <Command.List className="max-h-[60vh] overflow-y-auto p-2">
        {loading && (
          <Command.Loading>
            <div className="px-3 py-2 text-xs text-muted">Searching…</div>
          </Command.Loading>
        )}

        {hasQuery && !loading && !hasAnyResult && (
          <Command.Empty className="px-3 py-6 text-center text-sm text-muted">
            No results.
          </Command.Empty>
        )}

        {/* Tier 1 — Jump to (navigation rows, no snippet). */}
        {jumpTo.length > 0 && (
          <Command.Group
            heading="Jump to"
            className={GROUP_CLASS}
          >
            {jumpTo.map((hit) => (
              <ResultRow
                key={`jumpTo:${hit.path}`}
                hit={hit}
                lane="jumpTo"
                onPick={handlePick}
              />
            ))}
          </Command.Group>
        )}

        {/* Tier 2 — Assigned (only when non-empty; navigation rows, no snippet). */}
        {assigned.length > 0 && (
          <Command.Group
            heading="Assigned"
            className={GROUP_CLASS}
          >
            {assigned.map((hit) => (
              <ResultRow
                key={`assigned:${hit.path}`}
                hit={hit}
                lane="assigned"
                onPick={handlePick}
              />
            ))}
          </Command.Group>
        )}

        {/* Tier 3 — In content, grouped by entity kind (snippet rows). */}
        {content.length > 0 &&
          CONTENT_KIND_ORDER.map((kind) => {
            const hits = contentByKind.current[kind];
            if (!hits || hits.length === 0) return null;
            return (
              <Command.Group
                key={`content:${kind}`}
                heading={KIND_GROUP_HEADING[kind]}
                className={GROUP_CLASS}
              >
                {hits.map((hit) => (
                  <ResultRow
                    key={`content:${hit.path}`}
                    hit={hit}
                    lane="content"
                    onPick={handlePick}
                  />
                ))}
              </Command.Group>
            );
          })}
      </Command.List>
    </Command.Dialog>
  );
}
