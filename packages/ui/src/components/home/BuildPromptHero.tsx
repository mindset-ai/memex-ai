// spec-473 — the new /home for spec-less users, pivoted from spec-470's free-text
// "What do you want to build?" idea prompt to an IMPORT challenge: "your specs are
// just markdown — give us one, we'll make it a real Spec". The user hands over an
// existing document two ways — PASTE its text, or drag-drop / click-to-upload a
// markdown file (read in-browser, no upload endpoint) — and both feed the SAME
// create-spec agent seed (seedKind='document'), which restructures it into a real
// structured Spec (sections + decisions + ACs as rows, reusing spec-230). The user
// lands on the populated Spec (openOnCreate).
//
// Rendered by HomeCanvas when milestones.hasSpec is false (spec-470 dec-5); once the
// user has a spec the hero simply stops rendering (implicit graduation). Reuses the
// onboarding visual language — Inter (font-onboarding), brand blue (text-accent /
// bg-accent = #0482DC), theme-aware design tokens ([per std-27]).
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { useTelemetry } from '../../hooks/useTelemetry';
import { NewSpecModal } from '../NewSpecModal';

// ⚠️ PLACEHOLDER COPY — owner-owned (spec-473). Barrie writes the FINAL hero copy;
// these constants are intentionally trivial to swap. Do NOT treat the wording as
// final. The framing (Spec = structured database, not a document — the std-20
// dramatization) is the load-bearing part; the exact sentences are not.
const HERO_HEADLINE = "Your specs are just markdown — give us one, we'll make it a real Spec.";
const HERO_SUB =
  "Paste a spec, brief, or PRD — or drop in a markdown file — and we'll restructure it into a real Spec: sections, decisions, and acceptance criteria as queryable rows, not a document.";
const PASTE_PLACEHOLDER = 'Paste your spec, brief, or markdown here…';

// File handling (dec-1). Extension-checked — the browser's MIME for markdown is
// empty/unreliable, so the filename extension is the primary gate.
const MAX_FILE_BYTES = 1024 * 1024; // 1 MB
const ACCEPTED_EXTENSIONS = ['.md', '.markdown', '.txt'];
const FILE_ACCEPT_ATTR = '.md,.markdown,.txt,text/markdown,text/plain';
const ERR_UNSUPPORTED = 'Please upload a markdown or text file (.md, .markdown, .txt).';
const ERR_TOO_LARGE = 'That file is too large — please keep it under 1 MB.';
const ERR_UNREADABLE = "Couldn't read that file — please try again.";

function hasAcceptedExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

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
  const [doc, setDoc] = useState('');
  const [seed, setSeed] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // How the CURRENT document was provided — drives home.import_submitted.method
  // (a low-cardinality enum, [per std-35]). A file read flips it to 'file'; any
  // manual edit flips it back to 'paste'.
  const methodRef = useRef<'paste' | 'file'>('paste');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // home.import_shown — the activation-funnel denominator (dec-2, [per std-35]).
  // Fire once per mount, never per render.
  const shownRef = useRef(false);
  useEffect(() => {
    if (shownRef.current) return;
    shownRef.current = true;
    track('home.import_shown');
  }, [track]);

  // Read an uploaded/dropped file in-browser into the shared seed (dec-1). Bounded:
  // only .md/.markdown/.txt, ≤1 MB; anything else is rejected with in-hero feedback
  // and NEVER reaches the agent (ac-5). No server upload endpoint.
  const readFile = useCallback((file: File | undefined | null) => {
    if (!file) return;
    setError(null);
    if (!hasAcceptedExtension(file.name)) {
      setError(ERR_UNSUPPORTED);
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError(ERR_TOO_LARGE);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      methodRef.current = 'file';
      setFileName(file.name);
      setDoc(text);
    };
    reader.onerror = () => setError(ERR_UNREADABLE);
    reader.readAsText(file);
  }, []);

  const handleFileInput = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      readFile(e.target.files?.[0]);
      // Reset so re-selecting the same file still fires change.
      e.target.value = '';
    },
    [readFile],
  );

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOver(false);
      readFile(e.dataTransfer.files?.[0]);
    },
    [readFile],
  );

  const handleTextareaChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    methodRef.current = 'paste';
    setFileName(null);
    setError(null);
    setDoc(e.target.value);
  }, []);

  const handleSubmit = useCallback(() => {
    const document = doc.trim();
    // Empty/whitespace neither emits, opens the dialog, nor dispatches (ac-5).
    if (!document) return;
    // Intent event + the create funnel's create_clicked at the hero→dialog handoff
    // (dec-2, [per std-35]). Props carry no content — an enum + surface only.
    track('home.import_submitted', { method: methodRef.current });
    track('spec.create_clicked', { surface: 'home_hero' });
    setSeed(document);
    setModalOpen(true);
  }, [doc, track]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter inserts a newline (documents are multi-line); Cmd/Ctrl+Enter submits.
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  // Escape hatch so a spec-less user is never trapped on the hero (spec-470 dec-5).
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
          {HERO_HEADLINE}
        </h1>
        <p data-testid="hero-sub" className="mt-4 text-lg text-secondary">
          {HERO_SUB}
        </p>

        {/* Drop zone wraps the paste area — dropping a file anywhere over it reads
            the file (dec-1). The textarea is also the paste target. */}
        <div
          data-testid="hero-dropzone"
          onDrop={handleDrop}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            setDragOver(false);
          }}
          className={`relative mt-8 rounded-2xl transition ${
            dragOver ? 'ring-2 ring-accent ring-offset-2 ring-offset-surface' : ''
          }`}
        >
          <label htmlFor="build-prompt-input" className="sr-only">
            Paste your spec or markdown to import
          </label>
          <textarea
            id="build-prompt-input"
            data-testid="hero-input"
            value={doc}
            onChange={handleTextareaChange}
            onKeyDown={handleKeyDown}
            placeholder={PASTE_PLACEHOLDER}
            rows={7}
            autoFocus
            className="w-full resize-none rounded-2xl border border-edge bg-surface/60 px-5 py-4 pr-14 text-base text-primary shadow-sm outline-hidden transition focus:border-accent focus:ring-2 focus:ring-accent/40"
          />
          <button
            type="button"
            data-testid="hero-submit"
            aria-label="Import and build my Spec"
            onClick={handleSubmit}
            disabled={doc.trim().length === 0}
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

        {/* Upload affordance + accepted-types hint. The file input is visually
            hidden but keyboard-reachable via the labelled button (dec-1, [per std-27]). */}
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
          <button
            type="button"
            data-testid="hero-upload"
            onClick={() => fileInputRef.current?.click()}
            className="font-medium text-accent underline-offset-4 transition hover:underline"
          >
            Upload a markdown file
          </button>
          <span>or drag &amp; drop · .md, .markdown, .txt · up to 1&nbsp;MB</span>
          <input
            ref={fileInputRef}
            data-testid="hero-file-input"
            type="file"
            accept={FILE_ACCEPT_ATTR}
            onChange={handleFileInput}
            className="sr-only"
            tabIndex={-1}
            aria-hidden
          />
        </div>

        {fileName && !error && (
          <p data-testid="hero-filename" className="mt-2 text-sm text-secondary">
            Loaded <span className="font-medium">{fileName}</span>.
          </p>
        )}
        {error && (
          <p
            data-testid="hero-error"
            role="alert"
            aria-live="polite"
            className="mt-2 text-sm text-status-danger-text"
          >
            {error}
          </p>
        )}

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

      {/* dec-3: the imported document is auto-sent to the create-spec agent as a
          "convert this document into a structured Spec" turn (seedKind='document'),
          zero extra click. On a confirmed create the modal navigates to the Spec. */}
      <NewSpecModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        seedMessage={seed}
        seedKind="document"
        autoSend
        // The hero opens from the flat /home route, so hand the modal the user's
        // Specs-board path so post-create navigation resolves the tenant.
        specsBasePath={specsPath ?? undefined}
        // Land on the new Spec the instant it's created (beats the graduation unmount).
        openOnCreate
      />
    </div>
  );
}
