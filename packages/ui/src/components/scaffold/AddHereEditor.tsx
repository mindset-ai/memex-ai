// spec-343 t-5: the in-context "Add here" editor.
//
// dec-5 — replaces ScaffoldAdditionEditor's abstract target-dimension form.
// The target is DERIVED from the circumstance the admin is viewing (passed in
// as `target`) and shown in plain language; there are no raw phase/tool/
// transition dropdowns. An optional one-click "broaden" relaxes exactly one
// dimension. The per-memex Scope control (spec-193 t-5) is preserved.
//
// Visibility is gated upstream (admins only); the server is the authoritative
// gate. This is a UI affordance, not a security boundary.

import { useState } from 'react';
import type { GuidanceBlock, GuidanceEmphasis, GuidanceTarget } from '@memex/shared';
import { broadenOptions, describeTarget, isBroadTarget } from './targets';

interface SubmitInput {
  target: GuidanceBlock['target'];
  text: string;
  rationale: string;
  emphasis?: GuidanceEmphasis;
  memexId?: string;
}

interface Props {
  /** The target derived from the circumstance in view (dec-5). */
  target: GuidanceTarget;
  /** The button's visible label, when the target is button-scoped. */
  buttonLabel?: string;
  onSubmit?: (input: SubmitInput) => Promise<void>;
  /** Trigger label — defaults to "Add here". */
  label?: string;
  /** When true, the trigger renders visible-but-disabled with a tooltip — so
   *  viewers can SEE the capability even when they lack permission to use it. */
  disabled?: boolean;
  disabledReason?: string;
  currentMemexId?: string | null;
  currentMemexLabel?: string;
}

export function AddHereEditor({
  target: initialTarget,
  buttonLabel,
  onSubmit,
  label = 'Add here',
  disabled = false,
  disabledReason,
  currentMemexId,
  currentMemexLabel,
}: Props) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [rationale, setRationale] = useState('');
  const [emphasis, setEmphasis] = useState<GuidanceEmphasis | ''>('');
  // The effective target — starts at the derived one, may be broadened.
  const [target, setTarget] = useState<GuidanceTarget>(initialTarget);
  const [scope, setScope] = useState<'account' | 'memex'>('account');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options = broadenOptions(initialTarget);
  const broad = isBroadTarget(target);

  function reset() {
    setText('');
    setRationale('');
    setEmphasis('');
    setTarget(initialTarget);
    setScope('account');
    setError(null);
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
    if (!onSubmit) return;
    setSubmitting(true);
    try {
      const input: SubmitInput = {
        target,
        text: text.trim(),
        rationale: rationale.trim(),
      };
      if (emphasis) input.emphasis = emphasis;
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

  if (disabled) {
    return (
      <button
        type="button"
        data-testid="scaffold-add-here-trigger"
        disabled
        title={disabledReason ?? 'You do not have permission to edit this guidance.'}
        className="mt-3 cursor-not-allowed rounded-sm border border-default px-3 py-1 text-sm text-secondary opacity-50"
      >
        + {label}
      </button>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        data-testid="scaffold-add-here-trigger"
        onClick={() => setOpen(true)}
        className="mt-3 text-sm border border-default rounded-sm px-3 py-1 hover:bg-overlay"
      >
        + {label}
      </button>
    );
  }

  return (
    <form
      data-testid="scaffold-add-here-form"
      onSubmit={handleSubmit}
      className="mt-3 space-y-3 rounded-sm border border-default p-3 bg-muted/10"
    >
      {/* The derived target, in plain language — never a dimension builder. */}
      <div className="text-sm">
        <span className="font-semibold">This applies </span>
        <span data-testid="scaffold-add-here-target-summary">{describeTarget(target, buttonLabel)}</span>
        {broad ? (
          <span
            data-testid="scaffold-add-here-broad-flag"
            className="ml-2 text-xs rounded-sm bg-amber-200/40 text-amber-800 px-1.5 py-0.5"
          >
            broad — dilutes every nudge
          </span>
        ) : null}
      </div>

      {/* Optional one-click broaden. Relaxes one dimension; not a free editor. */}
      {options.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="scaffold-add-here-broaden">
          <span className="text-secondary">Broaden:</span>
          {options.map((opt) => {
            const active = JSON.stringify(opt.target) === JSON.stringify(target);
            return (
              <button
                key={opt.label}
                type="button"
                data-testid={`scaffold-add-here-broaden-option`}
                onClick={() => setTarget(active ? initialTarget : opt.target)}
                aria-pressed={active}
                className={`rounded-sm border px-2 py-0.5 ${
                  active ? 'border-amber-400 bg-amber-200/40 font-semibold' : 'border-default hover:bg-muted/30'
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      ) : null}

      <label className="text-xs block">
        <span className="block text-secondary mb-1">Your guidance (the agent reads this)</span>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          className="w-full text-xs border rounded-sm px-2 py-1 font-mono"
          data-testid="scaffold-add-here-text"
        />
      </label>

      <label className="text-xs block">
        <span className="block text-secondary mb-1">Why (note to admins — never sent to the agent)</span>
        <textarea
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          rows={2}
          className="w-full text-xs border rounded-sm px-2 py-1"
          data-testid="scaffold-add-here-rationale"
        />
      </label>

      <label className="text-xs block">
        <span className="block text-secondary mb-1">Emphasis (optional)</span>
        <select
          value={emphasis}
          onChange={(e) => setEmphasis((e.target.value || '') as GuidanceEmphasis | '')}
          className="text-xs border rounded-sm px-2 py-1"
          data-testid="scaffold-add-here-emphasis"
        >
          <option value="">(none)</option>
          <option value="do">do</option>
          <option value="dont">don&apos;t</option>
        </select>
      </label>

      {currentMemexId ? (
        <label className="text-xs block">
          <span className="block text-secondary mb-1">Scope</span>
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value === 'memex' ? 'memex' : 'account')}
            className="text-xs border rounded-sm px-2 py-1"
            data-testid="scaffold-add-here-scope"
          >
            <option value="account">Org-wide (all memexes)</option>
            <option value="memex">This memex only{currentMemexLabel ? ` (${currentMemexLabel})` : ''}</option>
          </select>
        </label>
      ) : null}

      {error ? (
        <div data-testid="scaffold-add-here-error" className="text-xs text-red-700">
          {error}
        </div>
      ) : null}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={submitting}
          data-testid="scaffold-add-here-submit"
          className="text-sm border border-default rounded-sm px-3 py-1 hover:bg-muted/30 disabled:opacity-50"
        >
          {submitting ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={() => {
            reset();
            setOpen(false);
          }}
          className="text-sm border border-default rounded-sm px-3 py-1 hover:bg-muted/30"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
