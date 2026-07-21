// spec-502 t-9 (ac-3): the console-demo step.
//
// A short, concrete console beat — a coding agent being told what to do over the
// Memex MCP, and the agent responding — so the connect ask (next step) arrives with
// a reason already attached. It cycles through several real MCP usages (draft a
// spec, resume one, search, check a standard, ground against code, resolve
// decisions, verify): each types out, holds, then auto-advances to the next. A
// Prev / dots / Next control lets the user drive; taking control pauses the
// auto-play. Portable (std-22): every example reads sensibly for ANY codebase — no
// building-itself / mindset specifics baked in.
//
// Motion (accessibility): the typing animation AND the auto-advance are both
// disabled under prefers-reduced-motion — the current example is shown in full and
// the user steps through with the controls, so nothing moves on its own.

import { useEffect, useState } from 'react';

export interface DemoExample {
  /** A short label for the example (shown above the controls). */
  readonly title: string;
  /** What the user types at the agent. Portable — no memex-specific content. */
  readonly command: string;
  /** The agent's one-line response, shown once the command finishes typing. */
  readonly response: string;
}

export interface ConsoleDemoProps {
  /** The examples to cycle through. Defaults to the MCP-usage set below. */
  readonly examples?: readonly DemoExample[];
  /**
   * Legacy single-command override (kept for callers/tests that pass one line):
   * when set, the demo shows exactly this command instead of the carousel.
   */
  readonly command?: string;
  /** Continue to the next wizard step (the connect gate). */
  readonly onDone: () => void;
}

// The default carousel — the common ways you drive Memex through your coding agent
// over MCP. Ordered as the real spec lifecycle: draft → resume → search → standards
// → ground/drift → resolve → verify.
export const DEFAULT_EXAMPLES: readonly DemoExample[] = [
  {
    title: 'Draft a spec',
    command: 'create a spec for the feature I am about to build',
    response: '✎ Drafting spec — capturing decisions and acceptance criteria…',
  },
  {
    title: 'Resume a spec',
    command: 'I want to work on memex.ai/acme/app/specs/spec-42',
    response: '↻ Reading the spec — orienting on its phase, updating the open tasks…',
  },
  {
    title: 'Search what you know',
    command: 'what did we decide about rate limiting, and why?',
    response: '⌕ Searching specs, standards & decisions — surfacing the ruling…',
  },
  {
    title: 'Check a standard',
    command: 'is there a standard for how we handle auth?',
    response: '§ Found the matching standard — and where the code should follow it…',
  },
  {
    title: 'Ground against code',
    command: 'check this spec against the code and flag any drift',
    response: '⚑ Grounding against the source — flagging where they have diverged…',
  },
  {
    title: 'Resolve decisions',
    command: 'resolve the open decisions on this spec',
    response: '✓ Recording the decisions — the spec can move to build…',
  },
  {
    title: 'Verify before shipping',
    command: 'is this spec ready to ship?',
    response: '✔ Verifying — acceptance criteria, tasks, and standards all green…',
  },
];

const DEFAULT_RESPONSE = '✎ Drafting spec — capturing decisions and acceptance criteria…';

// How long to hold a fully-typed example before auto-advancing (ms).
const HOLD_MS = 2600;
// Per-character typing speed (ms).
const TYPE_MS = 45;

function prefersReducedMotion(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  } catch {
    return false;
  }
}

export function ConsoleDemo({ examples, command, onDone }: ConsoleDemoProps) {
  // A single `command` override collapses the demo to one static example.
  const list: readonly DemoExample[] =
    command != null
      ? [{ title: 'Draft a spec', command, response: DEFAULT_RESPONSE }]
      : examples ?? DEFAULT_EXAMPLES;

  const reduced = prefersReducedMotion();
  const [index, setIndex] = useState(0);
  const [typed, setTyped] = useState(reduced ? list[0].command : '');
  // Auto-play only when motion is allowed and there is more than one example.
  // Once the user drives (Prev/Next/dot), we stop auto-advancing.
  const [paused, setPaused] = useState(reduced || list.length <= 1);

  const example = list[index] ?? list[0];
  const done = reduced || typed.length >= example.command.length;

  // Type the current example (skipped under reduced motion, which shows it whole).
  useEffect(() => {
    if (reduced) {
      setTyped(example.command);
      return;
    }
    setTyped('');
    let i = 0;
    const timer = setInterval(() => {
      i += 1;
      setTyped(example.command.slice(0, i));
      if (i >= example.command.length) clearInterval(timer);
    }, TYPE_MS);
    return () => clearInterval(timer);
  }, [example.command, reduced, index]);

  // Auto-advance once the line has finished and we're not paused.
  useEffect(() => {
    if (paused || reduced || !done) return;
    const hold = setTimeout(() => {
      setIndex((n) => (n + 1) % list.length);
    }, HOLD_MS);
    return () => clearTimeout(hold);
  }, [done, paused, reduced, list.length]);

  function go(to: number) {
    setPaused(true); // the user is driving now — stop the carousel
    setIndex((to + list.length) % list.length);
  }

  const multi = list.length > 1;

  return (
    <div data-testid="wizard-console-demo" className="animate-[panelIn_0.35s_ease] max-w-2xl flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="onboarding-heading">This is how you'll work</h2>
        <p className="text-base text-secondary">
          You drive Memex from your coding agent over MCP — describe, resume, search, or verify —
          and it keeps a living spec of decisions, tasks, and acceptance criteria in step with your
          code.
        </p>
      </div>

      <div
        data-testid="wizard-console"
        className="rounded-xl border border-edge bg-[#0b1020] text-slate-100 p-4 font-mono text-sm shadow-lg"
      >
        <div className="flex gap-1.5 mb-3" aria-hidden="true">
          <span className="h-3 w-3 rounded-full bg-red-400/70" />
          <span className="h-3 w-3 rounded-full bg-yellow-400/70" />
          <span className="h-3 w-3 rounded-full bg-green-400/70" />
        </div>
        {/* Both lines are always present so the console holds its 2-line height —
            the response text only fills once the command finishes typing, but its
            row is reserved from the start, so nothing below shifts (no jitter). */}
        <p data-testid="wizard-console-line" className="min-h-[1.5rem]">
          <span className="text-emerald-400">➜</span>{' '}
          <span className="text-slate-300">{typed}</span>
          {!done && <span className="animate-pulse">▋</span>}
        </p>
        <p
          data-testid="wizard-console-response"
          aria-hidden={!done}
          className={
            'mt-2 text-slate-400 min-h-[1.5rem] transition-opacity ' +
            (done ? 'opacity-100' : 'opacity-0')
          }
        >
          {done ? example.response : ' '}
        </p>
      </div>

      {/* Carousel controls — Prev · dots · Next. Only when there's more than one
          example. Driving them pauses the auto-play. */}
      {multi && (
        <div className="flex items-center justify-between gap-3" data-testid="wizard-demo-controls">
          <button
            type="button"
            data-testid="wizard-demo-prev"
            onClick={() => go(index - 1)}
            aria-label="Previous example"
            className="flex items-center gap-1 text-sm text-secondary hover:text-primary transition-colors"
          >
            <span aria-hidden="true">‹</span>
            <span>Prev</span>
          </button>

          <div className="flex items-center gap-2.5" role="tablist" aria-label="Examples">
            {list.map((ex, i) => (
              <button
                key={ex.title}
                type="button"
                role="tab"
                aria-selected={i === index}
                aria-label={ex.title}
                data-testid={`wizard-demo-dot-${i}`}
                onClick={() => go(i)}
                className={
                  'h-2 w-2 rounded-full transition-colors ' +
                  (i === index ? 'bg-accent' : 'bg-edge-strong hover:bg-secondary')
                }
              />
            ))}
          </div>

          <button
            type="button"
            data-testid="wizard-demo-next"
            onClick={() => go(index + 1)}
            aria-label="Next example"
            className="flex items-center gap-1 text-sm text-secondary hover:text-primary transition-colors"
          >
            <span>Next</span>
            <span aria-hidden="true">›</span>
          </button>
        </div>
      )}

      <button
        type="button"
        data-testid="wizard-demo-continue"
        onClick={onDone}
        className="self-start rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:opacity-90 transition-opacity"
      >
        Connect my agent
      </button>
    </div>
  );
}
