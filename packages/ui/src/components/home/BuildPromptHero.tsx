// spec-470 — the new /home for spec-less users. A Lovable-style full-takeover
// hero: one bold "What do you want to build?" prompt over a large free-text
// input. The typed sentence is handed straight to the existing agent-driven
// create-spec dialog (NewSpecModal) with a zero-extra-click auto-send (dec-4),
// so a brand-new user goes from a sentence to their first drafted Spec.
//
// Rendered by HomeCanvas when milestones.hasSpec is false (dec-5); once the user
// has a spec the hero simply stops rendering (implicit graduation). Reuses the
// onboarding visual language — Inter (font-onboarding), brand blue (text-accent
// / bg-accent = #0482DC), theme-aware design tokens (dec-7, [per std-27]).
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { useTelemetry } from '../../hooks/useTelemetry';
import { NewSpecModal } from '../NewSpecModal';

// Short, enticing examples that cycle in the placeholder to prompt typing (dec-7).
// Copy only — never prefilled into the field.
const PLACEHOLDER_EXAMPLES = [
  'A CLI that renames files by their EXIF date…',
  'A Slack bot that summarises unread threads…',
  'A dashboard showing our signup funnel…',
];
const PLACEHOLDER_INTERVAL_MS = 3200;

export function BuildPromptHero({
  firstName,
  specsPath,
}: {
  firstName: string | null;
  /** The user's Specs board path for the escape link; falls back to /specs. */
  specsPath: string | null;
}) {
  const navigate = useNavigate();
  const { track } = useTelemetry(true);
  const [input, setInput] = useState('');
  const [seed, setSeed] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // home.build_prompt_shown — the activation-funnel denominator (dec-8,
  // [per std-35]). Fire once per mount, never per render.
  const shownRef = useRef(false);
  useEffect(() => {
    if (shownRef.current) return;
    shownRef.current = true;
    track('home.build_prompt_shown');
  }, [track]);

  // Cycling placeholder — entices typing without prefilling the field (dec-7).
  const [placeholderIdx, setPlaceholderIdx] = useState(0);
  useEffect(() => {
    const id = setInterval(
      () => setPlaceholderIdx((i) => (i + 1) % PLACEHOLDER_EXAMPLES.length),
      PLACEHOLDER_INTERVAL_MS,
    );
    return () => clearInterval(id);
  }, []);

  const handleSubmit = useCallback(() => {
    const sentence = input.trim();
    // Empty/whitespace neither emits nor opens the dialog (dec-4).
    if (!sentence) return;
    // Intent event + the create funnel's create_clicked at the hero→dialog
    // handoff (dec-8, [per std-35]). Props carry no content — counts/enums only.
    track('home.build_prompt_submitted');
    track('spec.create_clicked', { surface: 'home_hero' });
    setSeed(sentence);
    setModalOpen(true);
  }, [input, track]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter submits; Shift+Enter is a newline (matches the composer convention).
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  // Escape hatch so a spec-less user is never trapped on the hero (dec-5). Not a
  // sticky dismissal — plain navigation to the board.
  const skipTarget = specsPath ?? '/specs';

  return (
    <div
      data-testid="build-prompt-hero"
      className="font-onboarding flex min-h-full flex-col items-center justify-center px-4 py-16"
    >
      <div className="w-full max-w-2xl">
        <p
          data-testid="hero-eyebrow"
          className="text-sm font-semibold uppercase tracking-wide text-accent"
        >
          Memex
        </p>
        {firstName && (
          <p data-testid="hero-greeting" className="mt-3 text-2xl text-secondary">
            Hi {firstName}.
          </p>
        )}
        <h1
          data-testid="hero-headline"
          className="mt-1 text-4xl font-semibold text-heading sm:text-5xl"
        >
          What do you want to build?
        </h1>
        <p data-testid="hero-sub" className="mt-4 text-lg text-secondary">
          Describe it in a sentence — I&apos;ll turn it into a spec.
        </p>

        <div className="relative mt-8">
          <label htmlFor="build-prompt-input" className="sr-only">
            Describe what you want to build
          </label>
          <textarea
            id="build-prompt-input"
            ref={inputRef}
            data-testid="hero-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={PLACEHOLDER_EXAMPLES[placeholderIdx]}
            rows={3}
            autoFocus
            className="w-full resize-none rounded-2xl border border-edge bg-surface/60 px-5 py-4 pr-14 text-lg text-primary shadow-sm outline-hidden transition focus:border-accent focus:ring-2 focus:ring-accent/40"
          />
          <button
            type="button"
            data-testid="hero-submit"
            aria-label="Start building"
            onClick={handleSubmit}
            disabled={input.trim().length === 0}
            className="absolute bottom-3 right-3 flex h-10 w-10 items-center justify-center rounded-xl bg-accent text-white transition hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <svg
              className="h-5 w-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </button>
        </div>

        <div className="mt-6">
          <button
            type="button"
            data-testid="hero-skip"
            onClick={() => navigate(skipTarget)}
            className="text-sm text-muted underline-offset-4 transition hover:text-secondary hover:underline"
          >
            Skip to my specs
          </button>
        </div>
      </div>

      {/* dec-4: the typed sentence is auto-sent as the agent's first turn — zero
          extra click. On a confirmed create the modal navigates to /specs/{handle}. */}
      <NewSpecModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        seedMessage={seed}
        autoSend
        // The hero opens from the flat /home route, so hand the modal the user's
        // Specs-board path — the memex the agent creates in — so post-create
        // navigation resolves the tenant (tenantPath can't, off a flat route).
        specsBasePath={specsPath ?? undefined}
        // Land on the new Spec the instant it's created. Creating it flips hasSpec,
        // which graduates the hero (and this modal) off /home — navigating away on
        // create both delivers the intended flow and beats that unmount.
        openOnCreate
      />
    </div>
  );
}
