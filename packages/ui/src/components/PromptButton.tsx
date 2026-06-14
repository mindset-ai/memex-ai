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
import { BASE_SCAFFOLD, toButtonPrompt, HANDOFF_BUTTON_BY_PHASE, type GuidanceBlock } from '@memex/shared';
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
  /**
   * spec-282 dec-5(A): stub mode for the three phase handoffs. When true the
   * dialog shows + the clipboard receives a SHORT, human-readable stub (the Spec
   * URL + a phase-specific "Get the <phase> prompt from memex…" instruction)
   * instead of the full scaffold payload — the coding agent fetches the full
   * prompt itself via the `get_prompt` MCP tool. The scaffold node
   * `text` is deliberately untouched: `get_prompt` (spec-263) projects that same
   * node and must keep serving the full prompt with byte-parity, so the stub is
   * a UI-layer projection only. The canonical ref + title + URL are read from
   * `context` (the handoff context already carries namespace/memex/handle/...).
   */
  stub?: boolean;
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

// spec-282 dec-5(A): the short get_prompt stub that the three phase-handoff copy
// actions place on the clipboard. Deliberately human-readable — a person reading
// it learns how to drive Memex from their coding agent: point the agent at the
// Spec URL and tell it to fetch the phase prompt from Memex (which the agent does
// via the `get_prompt` MCP tool, deriving the ref from the URL path). The agent
// calls `get_prompt` to fetch the full scaffold (Org appends included), so this
// stays a UI-layer projection and the scaffold node text is never edited
// (get_prompt byte-parity, spec-263). The second line is PHASE-SPECIFIC: the
// phase word is the CANONICAL phase name, looked up from HANDOFF_BUTTON_BY_PHASE
// (phase→buttonId) inverted. It must NOT come from the node `label`: the specify
// handoff is historically labelled "Plan handoff", so a label-first-word
// derivation mislabels the specify phase as "plan" — the phase is `specify`.
const PHASE_BY_HANDOFF_BUTTON: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(HANDOFF_BUTTON_BY_PHASE).map(([phase, id]) => [id, phase]),
);

function buildHandoffStub(context: Record<string, unknown>, buttonId: string): string {
  const str = (k: string) => String(context[k] ?? '');
  const phase = PHASE_BY_HANDOFF_BUTTON[buttonId] ?? '';
  return [
    `Use memex spec: ${str('url')}`,
    `Get the ${phase} prompt from memex and ask the user how they want to proceed.`,
  ].join('\n');
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
      // spec-282 dec-5(B): the copied state is STICKY (no auto-reset) — once the
      // clipboard is loaded the dialog stays in its "Copied. Now go and paste"
      // state: the confirmation sits next to the action and the copy button has
      // become a Close button (one obvious click to dismiss).
      setCopied(true);
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

        {/* Guidance — plain prose, deliberately NOT boxed (spec-282 dec-5): the
            bordered "canvas" treatment is reserved for the prompt artifact
            below, so the thing you copy is the thing that looks liftable. */}
        <p className="mx-5 mt-4 text-xs text-secondary">
          <span className="font-medium text-heading">Copy this prompt and paste it into a coding-agent session</span>{' '}
          (e.g. Claude Code) to hand the work off. It's also a template — read it to learn the
          prompting pattern.
        </p>

        {copyFailed && (
          <p role="alert" className="px-5 pt-3 text-xs text-status-danger-text">
            Couldn't write to the clipboard — select the text below and copy it manually.
          </p>
        )}

        {/* The prompt sits on its own canvas — a bordered, inset surface
            distinct from the dialog chrome — so it reads as the artifact to
            copy (spec-282 dec-5). Read-only (D-1): shown verbatim and selectable
            but not editable; Copy emits exactly this text. */}
        <pre className="flex-1 overflow-auto mx-5 my-4 p-4 rounded-lg border border-edge bg-surface text-xs text-secondary whitespace-pre-wrap break-words select-text">
          {prompt}
        </pre>

        {/* spec-282 dec-5(B): once copied, the confirmation sits right next to
            the action and the copy button has BECOME the Close button — one
            obvious click to dismiss and get back to the coding agent. */}
        <div className="flex items-center justify-end gap-3 px-5 py-3 border-t border-edge">
          {copied ? (
            <>
              <p
                role="status"
                data-testid="copy-confirmation"
                className="text-xs font-medium text-heading"
              >
                Copied. Now go to your coding agent and paste.
              </p>
              <Button type="button" variant="agent" size="sm" onClick={onClose} autoFocus>
                Close
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="secondary" size="sm" onClick={onClose}>
                Close
              </Button>
              <Button type="button" variant="agent" size="sm" onClick={handleCopy}>
                Copy prompt
              </Button>
            </>
          )}
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
  stub = false,
  disabled = false,
  variant = 'agent',
  onCopy,
}: PromptButtonProps) {
  const [open, setOpen] = useState(false);

  const node = BASE_SCAFFOLD.promptButtons.find((b) => b.id === buttonId) ?? null;
  const prompt = node ? toButtonPrompt({ dataset: BASE_SCAFFOLD, buttonId, context, orgBlocks }) : null;

  // Missing-node policy (D-4): a typo'd buttonId is a wiring bug — loud in
  // dev/test, invisible in prod. (We still resolve the node in stub mode — it
  // supplies the dialog label — even though the stub, not the node's full text,
  // is what the clipboard receives.)
  if (!node || prompt === null) {
    const message = `<PromptButton>: no PromptButtonNode found for buttonId="${buttonId}"`;
    if (import.meta.env.DEV) throw new Error(message);
    // eslint-disable-next-line no-console
    console.error(message);
    return null;
  }

  // spec-282 dec-5(A): in stub mode the dialog shows + copies the short
  // get_prompt stub; otherwise the full scaffold prompt.
  const dialogPrompt = stub ? buildHandoffStub(context, buttonId) : prompt;

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
            prompt={dialogPrompt}
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
          prompt={dialogPrompt}
          onCopy={onCopy}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
