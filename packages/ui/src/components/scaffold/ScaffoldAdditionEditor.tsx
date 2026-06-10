// b-68 t-14: inline authoring editor.
//
// A small admin-only form that captures the fields of a new GuidanceBlock:
// target (phase / tool / phase+tool / transition / org-global), text,
// rationale, optional emphasis. Submits via the parent's `onSubmit` callback;
// the parent owns the API call + cache refresh.
//
// Non-admins simply never render this component (we gate visibility upstream)
// — per ac-13. The server is the authoritative gate; this is a UI affordance,
// not a security boundary.

import { useState } from 'react';
import type { GuidanceBlock, GuidanceEmphasis, Phase, Transition } from '@memex/shared';

interface SubmitInput {
  target: GuidanceBlock['target'];
  text: string;
  rationale: string;
  emphasis?: GuidanceEmphasis;
  // spec-193 t-5: per-memex scope. Omitted = account-wide; a memex UUID scopes
  // the block to that one memex.
  memexId?: string;
}

interface Props {
  initialTarget: GuidanceBlock['target'];
  onSubmit: (input: SubmitInput) => Promise<void>;
  label?: string;
  // spec-193 t-5: the memex this Inspect page is anchored to. When present, the
  // editor offers a Scope control (account-wide vs this memex). Absent (e.g. an
  // org with no resolved memex) → the control hides and blocks are account-wide.
  currentMemexId?: string | null;
  currentMemexLabel?: string;
}

const PHASES: Phase[] = ['draft', 'specify', 'build', 'verify', 'done'];
const TRANSITIONS: Transition[] = ['specify', 'build', 'verify', 'done'];

export function ScaffoldAdditionEditor({
  initialTarget,
  onSubmit,
  label = 'Add guidance',
  currentMemexId,
  currentMemexLabel,
}: Props) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [rationale, setRationale] = useState('');
  const [emphasis, setEmphasis] = useState<GuidanceEmphasis | ''>('');
  const [phase, setPhase] = useState<Phase | ''>(initialTarget.phase ?? '');
  const [tool, setTool] = useState<string>(initialTarget.tool ?? '');
  const [transition, setTransition] = useState<Transition | ''>(initialTarget.transition ?? '');
  // spec-193 t-5: 'account' = account-wide (memexId NULL); 'memex' = this memex.
  // Defaults to account-wide so the existing behaviour is the no-op path.
  const [scope, setScope] = useState<'account' | 'memex'>('account');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setText('');
    setRationale('');
    setEmphasis('');
    setPhase(initialTarget.phase ?? '');
    setTool(initialTarget.tool ?? '');
    setTransition(initialTarget.transition ?? '');
    setScope('account');
    setError(null);
  }

  function buildTarget(): GuidanceBlock['target'] {
    const out: GuidanceBlock['target'] = {};
    if (phase) out.phase = phase;
    if (tool.trim().length > 0) out.tool = tool.trim();
    if (transition) out.transition = transition;
    return out;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (text.trim().length === 0) {
      setError('text is required');
      return;
    }
    if (rationale.trim().length === 0) {
      setError('rationale is required');
      return;
    }
    setSubmitting(true);
    try {
      const input: SubmitInput = {
        target: buildTarget(),
        text: text.trim(),
        rationale: rationale.trim(),
      };
      if (emphasis) input.emphasis = emphasis;
      // spec-193 t-5: only attach a memexId when the admin picked "this memex"
      // AND a memex is resolved; otherwise the block stays account-wide.
      if (scope === 'memex' && currentMemexId) input.memexId = currentMemexId;
      await onSubmit(input);
      reset();
      setOpen(false);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to save');
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        data-testid="scaffold-add-guidance-trigger"
        onClick={() => setOpen(true)}
        className="mt-3 text-sm border border-default rounded px-3 py-1 hover:bg-muted/30"
      >
        + {label}
      </button>
    );
  }

  return (
    <form
      data-testid="scaffold-add-guidance-form"
      onSubmit={handleSubmit}
      className="mt-3 space-y-3 rounded border border-default p-3 bg-muted/10"
    >
      <div className="text-sm font-semibold">{label}</div>

      <div className="grid grid-cols-3 gap-2">
        <label className="text-xs">
          <span className="block text-secondary mb-1">Phase</span>
          <select
            value={phase}
            onChange={(e) => setPhase((e.target.value || '') as Phase | '')}
            className="w-full text-xs border rounded px-2 py-1"
            data-testid="scaffold-add-target-phase"
          >
            <option value="">(any)</option>
            {PHASES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs">
          <span className="block text-secondary mb-1">Tool</span>
          <input
            type="text"
            value={tool}
            onChange={(e) => setTool(e.target.value)}
            placeholder="(any)"
            className="w-full text-xs border rounded px-2 py-1"
            data-testid="scaffold-add-target-tool"
          />
        </label>
        <label className="text-xs">
          <span className="block text-secondary mb-1">Transition</span>
          <select
            value={transition}
            onChange={(e) => setTransition((e.target.value || '') as Transition | '')}
            className="w-full text-xs border rounded px-2 py-1"
            data-testid="scaffold-add-target-transition"
          >
            <option value="">(none)</option>
            {TRANSITIONS.map((t) => (
              <option key={t} value={t}>
                →{t}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="text-xs block">
        <span className="block text-secondary mb-1">Text (agent-facing)</span>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          className="w-full text-xs border rounded px-2 py-1 font-mono"
          data-testid="scaffold-add-text"
        />
      </label>

      <label className="text-xs block">
        <span className="block text-secondary mb-1">Rationale (admin-facing)</span>
        <textarea
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          rows={2}
          className="w-full text-xs border rounded px-2 py-1"
          data-testid="scaffold-add-rationale"
        />
      </label>

      <label className="text-xs block">
        <span className="block text-secondary mb-1">Emphasis (optional)</span>
        <select
          value={emphasis}
          onChange={(e) => setEmphasis((e.target.value || '') as GuidanceEmphasis | '')}
          className="text-xs border rounded px-2 py-1"
          data-testid="scaffold-add-emphasis"
        >
          <option value="">(none)</option>
          <option value="do">do</option>
          <option value="dont">don&apos;t</option>
        </select>
      </label>

      {/* spec-193 t-5: per-memex scope. Only offered when a memex is resolved;
          account-wide stays the default. Account-wide applies to every memex in
          the namespace; "this memex" scopes the block to the current one. */}
      {currentMemexId ? (
        <label className="text-xs block">
          <span className="block text-secondary mb-1">Scope</span>
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value === 'memex' ? 'memex' : 'account')}
            className="text-xs border rounded px-2 py-1"
            data-testid="scaffold-add-scope"
          >
            <option value="account">Account-wide (all memexes)</option>
            <option value="memex">
              This memex only{currentMemexLabel ? ` (${currentMemexLabel})` : ''}
            </option>
          </select>
        </label>
      ) : null}

      {error ? (
        <div data-testid="scaffold-add-error" className="text-xs text-red-700">
          {error}
        </div>
      ) : null}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={submitting}
          data-testid="scaffold-add-submit"
          className="text-sm border border-default rounded px-3 py-1 hover:bg-muted/30 disabled:opacity-50"
        >
          {submitting ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={() => {
            reset();
            setOpen(false);
          }}
          className="text-sm border border-default rounded px-3 py-1 hover:bg-muted/30"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
