// spec-502 t-7 (dec-3, ac-2/ac-12): the wizard's name-it step.
//
// ONE pre-filled, editable field — the Memex name — and nothing else. No org
// creation or selection anywhere (dec-3): org is an unfamiliar concept at the
// highest-friction moment, right after the "Create your own Memex" CTA. The name
// defaults to something concrete (the user's codebase or a friendly default) and
// targets the user's existing personal Memex (dec-2 — no new provisioning).

import { useState, type FormEvent } from 'react';

export interface NameStepProps {
  /** Pre-filled default (e.g. the user's codebase name or `my-first-memex`). */
  readonly defaultName: string;
  /** Called with the (possibly edited) name when the user continues. */
  readonly onSubmit: (name: string) => void;
}

export function NameStep({ defaultName, onSubmit }: NameStepProps) {
  const [name, setName] = useState(defaultName);
  const trimmed = name.trim();

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!trimmed) return;
    onSubmit(trimmed);
  }

  return (
    <form
      data-testid="wizard-name-step"
      onSubmit={handleSubmit}
      className="animate-[panelIn_0.35s_ease] max-w-lg flex flex-col gap-4"
    >
      <div className="flex flex-col gap-1">
        <h2 className="onboarding-heading">Name your Memex</h2>
        <p className="text-base text-secondary">
          This is your workspace — a living map of your codebase's specs, decisions, and standards.
          You can rename it any time.
        </p>
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-secondary">Memex name</span>
        <input
          data-testid="wizard-memex-name"
          type="text"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          className="rounded-lg border border-edge bg-surface px-3 py-2 text-sm text-primary focus:border-accent focus:outline-hidden"
        />
      </label>

      <button
        type="submit"
        data-testid="wizard-name-continue"
        disabled={!trimmed}
        className="self-start rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent transition-opacity hover:opacity-90 disabled:opacity-40"
      >
        Continue
      </button>
    </form>
  );
}
