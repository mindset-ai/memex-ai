// spec-343 t-3 / t-4 / t-5 / t-7: the circumstance detail.
//
// This component IS the composed prompt the agent receives for one circumstance
// — rendered as an ordered stack of segments (base prose vs the team's
// additions, inline, in composition order), NOT a separate monospace "Live
// preview" pane (dec-4: the old preview is deleted; the detail and the preview
// are one object). Org segments carry their enable toggle, edit, delete, and
// author/timestamp inline. The "Add here" editor (dec-5) derives its target
// from this circumstance. A reach badge (dec-6) states whether the circumstance
// reaches both agents or only the in-app one. The base "why this exists"
// rationale is one click away (dec-7), never front-loaded.

import { useState } from 'react';
import type { GuidanceBlock, GuidanceEmphasis, GuidanceTarget } from '@memex/shared';
import type { ComposedSegment } from './composition';
import { AddHereEditor } from './AddHereEditor';
import { MarkdownText } from './MarkdownText';

export type Reach = 'both' | 'react_only';

interface CreateInput {
  target: GuidanceBlock['target'];
  text: string;
  rationale: string;
  emphasis?: GuidanceEmphasis;
  memexId?: string;
}

interface Props {
  title: string;
  subtitle?: string;
  /** Base "why this exists" — surfaced on demand, never front-loaded. */
  rationale?: string;
  segments: readonly ComposedSegment[];
  /** When set (and admin), shows the in-context "Add here" editor. */
  addTarget?: GuidanceTarget;
  buttonLabel?: string;
  /** Reach badge (dec-6). Omit to hide (e.g. a pure base read-only block list). */
  reach?: Reach;
  isAdmin: boolean;
  /** Why editing is unavailable — shown as the disabled "Add here" tooltip. */
  disabledReason?: string;
  onCreate?: (input: CreateInput) => Promise<void>;
  onToggle?: (id: string, enabled: boolean) => Promise<void>;
  onUpdate?: (id: string, text: string) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
  currentMemexId?: string | null;
  currentMemexLabel?: string;
  testId?: string;
  emptyHint?: string;
}

function ReachBadge({ reach }: { reach: Reach }) {
  const both = reach === 'both';
  return (
    <span
      data-testid="scaffold-reach-badge"
      data-reach={reach}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
        both ? 'bg-emerald-400/15 text-emerald-400' : 'bg-sky-400/15 text-sky-400'
      }`}
    >
      <span aria-hidden="true">●</span>
      {both ? 'Both agents' : 'In-app only'}
    </span>
  );
}

export function CircumstanceDetail({
  title,
  subtitle,
  rationale,
  segments,
  addTarget,
  buttonLabel,
  reach,
  isAdmin,
  disabledReason,
  onCreate,
  onToggle,
  onUpdate,
  onDelete,
  currentMemexId,
  currentMemexLabel,
  testId,
  emptyHint = 'No base guidance here yet.',
}: Props) {
  const [showWhy, setShowWhy] = useState(false);

  return (
    <section data-testid={testId ?? 'scaffold-circumstance-detail'} className="space-y-4">
      <header className="space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <h2 className="text-lg font-semibold text-heading">{title}</h2>
          {reach ? <ReachBadge reach={reach} /> : null}
          {rationale ? (
            <button
              type="button"
              data-testid="scaffold-why-toggle"
              onClick={() => setShowWhy((v) => !v)}
              className="text-xs text-link underline"
              aria-expanded={showWhy}
            >
              {showWhy ? 'hide why' : 'ⓘ why'}
            </button>
          ) : null}
        </div>
        {subtitle ? <p className="text-sm text-secondary">{subtitle}</p> : null}
        {rationale && showWhy ? (
          <p
            data-testid="scaffold-why-text"
            className="text-xs text-secondary italic border-l-2 border-amber-300 pl-3 py-1"
          >
            {rationale}
          </p>
        ) : null}
      </header>

      {/* The composed prompt, in composition order. Consecutive base prose is
          merged into one "Built-in" box; each team addition is its own box. */}
      <div data-testid="scaffold-composed" className="space-y-2">
        {segments.length === 0 ? (
          <p className="text-sm text-secondary">{emptyHint}</p>
        ) : (
          groupSegments(segments).map((group, i) =>
            group.source === 'base' ? (
              <BaseBlock key={`base-${i}`} text={group.texts.join('\n\n')} />
            ) : (
              <OrgSegment
                key={group.seg.id ?? `org-${i}`}
                segment={group.seg}
                isAdmin={isAdmin}
                onToggle={onToggle}
                onUpdate={onUpdate}
                onDelete={onDelete}
              />
            ),
          )
        )}
      </div>

      {addTarget ? (
        <AddHereEditor
          target={addTarget}
          buttonLabel={buttonLabel}
          onSubmit={onCreate}
          disabled={!isAdmin || !onCreate}
          disabledReason={disabledReason}
          currentMemexId={currentMemexId}
          currentMemexLabel={currentMemexLabel}
        />
      ) : null}
    </section>
  );
}

// Consecutive base prose collapses into one block; team additions stay
// individual (each carries its own controls + provenance).
type SegmentGroup =
  | { source: 'base'; texts: string[] }
  | { source: 'org'; seg: ComposedSegment };

function groupSegments(segments: readonly ComposedSegment[]): SegmentGroup[] {
  const groups: SegmentGroup[] = [];
  for (const seg of segments) {
    const last = groups[groups.length - 1];
    if (seg.source === 'base' && last && last.source === 'base') {
      last.texts.push(seg.text);
    } else if (seg.source === 'base') {
      groups.push({ source: 'base', texts: [seg.text] });
    } else {
      groups.push({ source: 'org', seg });
    }
  }
  return groups;
}

function BaseBlock({ text }: { text: string }) {
  return (
    <div
      data-testid="scaffold-segment"
      data-source="base"
      className="rounded-lg border border-edge bg-surface p-4 space-y-2"
    >
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">Built-in</div>
      <MarkdownText text={text} />
    </div>
  );
}

function OrgSegment({
  segment,
  isAdmin,
  onToggle,
  onUpdate,
  onDelete,
}: {
  segment: ComposedSegment;
  isAdmin: boolean;
  onToggle?: (id: string, enabled: boolean) => Promise<void>;
  onUpdate?: (id: string, text: string) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
}) {
  const block = segment.block;
  const id = segment.id;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(segment.text);

  const author = block?.authorId;
  const updatedAt = block?.updatedAt;

  return (
    <div
      data-testid="scaffold-segment"
      data-source="org"
      className="rounded-lg border border-amber-400/40 bg-surface p-4 space-y-2"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-500">Your org</span>
        {isAdmin && id ? (
          <div className="flex items-center gap-2 text-xs">
            {onToggle ? (
              <label className="inline-flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={block?.enabled ?? true}
                  onChange={(e) => void onToggle(id, e.target.checked)}
                  data-testid={`scaffold-org-toggle-${id}`}
                />
                <span>enabled</span>
              </label>
            ) : null}
            {onUpdate ? (
              <button
                type="button"
                data-testid={`scaffold-org-edit-${id}`}
                onClick={() => {
                  setDraft(segment.text);
                  setEditing((v) => !v);
                }}
                className="text-link underline"
              >
                {editing ? 'cancel' : 'edit'}
              </button>
            ) : null}
            {onDelete ? (
              <button
                type="button"
                data-testid={`scaffold-org-delete-${id}`}
                onClick={() => void onDelete(id)}
                className="text-red-700 underline"
              >
                delete
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {editing && id && onUpdate ? (
        <div className="space-y-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            className="w-full text-xs border rounded-sm px-2 py-1 font-mono"
            data-testid={`scaffold-org-edit-text-${id}`}
          />
          <button
            type="button"
            data-testid={`scaffold-org-edit-save-${id}`}
            onClick={async () => {
              await onUpdate(id, draft.trim());
              setEditing(false);
            }}
            className="text-xs border border-default rounded-sm px-2 py-0.5 hover:bg-muted/30"
          >
            Save
          </button>
        </div>
      ) : (
        <MarkdownText text={segment.text} />
      )}

      {author || updatedAt ? (
        <div className="text-[11px] text-muted">
          {author ? <>by {author}</> : null}
          {author && updatedAt ? ' · ' : ''}
          {updatedAt ? <>updated {updatedAt}</> : null}
        </div>
      ) : null}
    </div>
  );
}
