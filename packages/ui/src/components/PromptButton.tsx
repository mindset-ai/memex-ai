// spec-103 t-5: the reusable Prompt Button primitive.
//
// Clicking the button opens a dialog that shows the context-aware,
// Scaffold-sourced prompt (spec-103 D-7) with explicit guidance to copy it and
// paste it into a coding-agent session — the dialog IS the point of the button,
// not a silent clipboard write. The prompt is NOT inline here: it's a
// `PromptButtonNode` in `BASE_SCAFFOLD`, composed + interpolated by
// `toButtonPrompt`. `label` is template metadata on the node, never a surface
// prop (D-6). Read-only preview (D-1). No analytics (D-2).

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { BASE_SCAFFOLD, toButtonPrompt, type GuidanceBlock } from '@memex/shared';
import { Button } from './ui';

export interface PromptButtonProps {
  /** Resolves a `PromptButtonNode` in the Scaffold. */
  buttonId: string;
  /** Variables interpolated into the template's `{...}` placeholders. */
  context: Record<string, unknown>;
  /** Render the visible text label (default true, per D-6). Ignored in the
   *  sentence form, which always shows the "Copy" link. */
  showLabel?: boolean;
  /**
   * spec-159 ac-17 — the sentence form. When set, the button renders as a
   * "Copy" hyperlink-styled action followed by `sentence` as prose (e.g.
   * "Copy and paste this prompt into your coding agent to create Decisions…").
   * The leading "Copy" word is the action; `sentence` is the rest of the
   * sentence WITHOUT the word "Copy". May be a ReactNode so entity names can
   * render bold. Clicking "Copy" opens the same handoff dialog as the
   * standalone-button form. When omitted, the legacy labelled icon-button
   * renders (backward compatible).
   */
  sentence?: React.ReactNode;
  /** Prose rendered BEFORE the link (e.g. "Copy and paste "). Lets the
   *  clickable words sit mid-sentence: {prefix}<link>{linkText}</link> {sentence}. */
  sentencePrefix?: React.ReactNode;
  /** The clickable words of the sentence form. Defaults to "Copy". */
  linkText?: string;
  /** Plain-text version of the FULL sentence for the accessible name. Required
   *  in spirit when `sentence` is a non-string node; falls back to
   *  "Copy <sentence string>", then to the node label. */
  sentenceLabel?: string;
  /** Enabled Org appends for this button (delivered with the session; t-4). */
  orgBlocks?: readonly GuidanceBlock[];
  disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'ghost' | 'agent';
  /** Fired with the composed prompt after a successful copy. */
  onCopy?: (prompt: string) => void;
}

// Lucide `terminal` glyph (https://lucide.dev/icons/terminal), inlined to match
// the codebase's inline-SVG idiom and avoid a new icon dependency.
function TerminalIcon() {
  return (
    <svg
      className="w-3.5 h-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function PromptDialog({
  label,
  prompt,
  onCopy,
  onClose,
}: {
  label: string;
  prompt: string;
  onCopy?: (prompt: string) => void;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopyFailed(false);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
      onCopy?.(prompt);
    } catch {
      // Clipboard blocked (NotAllowedError / non-HTTPS): the prompt is already
      // on screen and selectable, so we just tell the user to copy manually.
      setCopyFailed(true);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${label} prompt`}
        className="w-full sm:w-[900px] sm:max-w-[92vw] max-h-[85vh] flex flex-col rounded-t-xl sm:rounded-xl border border-edge bg-panel shadow-2xl"
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-edge">
          <h2 className="text-sm font-semibold text-heading">{label} prompt</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="p-1 rounded-md text-muted hover:text-primary hover:bg-overlay transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Guidance — the whole point of the dialog: copy this, paste into a
            coding agent. */}
        <div className="mx-5 mt-4 rounded-md border border-edge bg-overlay/40 px-3 py-2 text-xs text-secondary">
          <span className="font-medium text-heading">Copy this prompt and paste it into a coding-agent session</span>{' '}
          (e.g. Claude Code) to hand the work off. It's also a template — read it to learn the
          prompting pattern.
        </div>

        {copyFailed && (
          <p role="alert" className="px-5 pt-3 text-xs text-status-danger-text">
            Couldn't write to the clipboard — select the text below and copy it manually.
          </p>
        )}

        {/* Read-only (D-1): the prompt is shown verbatim and is selectable, but
            not editable — Copy emits exactly this text. */}
        <pre className="flex-1 overflow-auto mx-5 my-4 p-3 rounded-md bg-overlay/30 text-xs text-secondary whitespace-pre-wrap break-words select-text">
          {prompt}
        </pre>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-edge">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>
            Close
          </Button>
          <Button type="button" variant="agent" size="sm" onClick={handleCopy}>
            {copied ? 'Copied ✓' : 'Copy prompt'}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function PromptButton({
  buttonId,
  context,
  showLabel = true,
  sentence,
  sentencePrefix,
  linkText = 'Copy',
  sentenceLabel,
  orgBlocks,
  disabled = false,
  variant = 'agent',
  onCopy,
}: PromptButtonProps) {
  const [open, setOpen] = useState(false);

  const node = BASE_SCAFFOLD.promptButtons.find((b) => b.id === buttonId) ?? null;
  const prompt = node ? toButtonPrompt({ dataset: BASE_SCAFFOLD, buttonId, context, orgBlocks }) : null;

  // Missing-node policy (D-4): a typo'd buttonId is a wiring bug — loud in
  // dev/test, invisible in prod.
  if (!node || prompt === null) {
    const message = `<PromptButton>: no PromptButtonNode found for buttonId="${buttonId}"`;
    if (import.meta.env.DEV) throw new Error(message);
    // eslint-disable-next-line no-console
    console.error(message);
    return null;
  }

  // spec-159 ac-17 — the sentence form. The clickable words (`linkText`, default
  // "Copy") render as a hyperlink-styled <button> (it performs an action, not
  // navigation, so it's a button for a11y), optionally preceded by
  // `sentencePrefix` prose and followed by `sentence` prose — so the link can
  // sit mid-sentence: "Copy and paste *this prompt* into your coding agent…".
  // Clicking the link opens the same handoff dialog. The accessible name
  // carries the FULL sentence so the action is self-describing to assistive
  // tech.
  if (sentence) {
    const copyLabel =
      sentenceLabel ?? (typeof sentence === 'string' ? `Copy ${sentence}` : node.label);
    return (
      <>
        <p className="text-sm text-secondary">
          {sentencePrefix}
          <button
            type="button"
            disabled={disabled}
            aria-label={copyLabel}
            onClick={() => setOpen(true)}
            className="font-medium text-accent underline underline-offset-2 hover:text-accent-hover disabled:opacity-50 disabled:no-underline"
          >
            {/* spec-247 ac-15 (c-4): the terminal glyph rides the link text so
                every copy-prompt affordance is recognisable as one, even
                mid-sentence. */}
            <span className="inline-flex items-baseline gap-1">
              <span className="self-center" aria-hidden="true">
                <TerminalIcon />
              </span>
              {linkText}
            </span>
          </button>{' '}
          {sentence}
        </p>

        {open && (
          <PromptDialog
            label={node.label}
            prompt={prompt}
            onCopy={onCopy}
            onClose={() => setOpen(false)}
          />
        )}
      </>
    );
  }

  // Legacy labelled-button form (backward compatible).
  const openLabel = `Show the ${node.label} prompt to copy into a coding agent`;

  return (
    <>
      <Button
        type="button"
        variant={variant}
        size="sm"
        disabled={disabled}
        aria-label={openLabel}
        title={openLabel}
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5"
      >
        <TerminalIcon />
        {showLabel && <span>{node.label}</span>}
      </Button>

      {open && (
        <PromptDialog
          label={node.label}
          prompt={prompt}
          onCopy={onCopy}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
