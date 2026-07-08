// spec-473 t-2 — the pivoted /home IMPORT hero. It leads solely with the import
// challenge (ac-1/ac-4/ac-7), takes a document by paste OR by in-browser file read
// (ac-2/ac-8), rejects oversized/unsupported files and guards empty input (ac-5/ac-8),
// and emits the import activation funnel (ac-10). NewSpecModal is stubbed to a sentinel
// that echoes the props it received, so we can assert the document seed + seedKind
// handoff without dragging in the agent graph (the modal seam is covered by
// NewSpecModal.spec-473.test.tsx).
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';

const AC = 'mindset-prod/memex-building-itself/specs/spec-473/acs';

const trackMock = vi.fn();
vi.mock('../../hooks/useTelemetry', () => ({
  useTelemetry: () => ({ track: trackMock, optedOut: false, setOptOut: vi.fn() }),
}));

// Stub the modal to echo the props the hero hands it, so we can assert the document
// seed + seedKind='document' handoff (the real dispatch is tested against the modal).
vi.mock('../NewSpecModal', () => ({
  NewSpecModal: ({
    open,
    seedMessage,
    seedKind,
  }: {
    open: boolean;
    seedMessage?: string;
    seedKind?: string;
  }) =>
    open ? (
      <div
        data-testid="new-spec-modal-open"
        data-seed-kind={seedKind}
        data-seed={seedMessage}
      />
    ) : null,
}));

import { BuildPromptHero } from './BuildPromptHero';

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="probe" data-path={loc.pathname} />;
}

function renderHero(specsPath: string | null = '/alice/personal/specs') {
  return render(
    <MemoryRouter initialEntries={['/home']}>
      <Routes>
        <Route
          path="/home"
          element={<BuildPromptHero firstName="Alice" specsPath={specsPath} />}
        />
        <Route path="/alice/personal/specs" element={<LocationProbe />} />
        <Route path="/specs" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

function mdFile(content: string, name = 'brief.md', type = 'text/markdown') {
  return new File([content], name, { type });
}

beforeEach(() => {
  trackMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

const SUBSTANTIAL_DOC =
  '# Realtime Presence PRD\n## Problem\nUsers cannot tell who is viewing a doc.\n## Goals\n- Live avatars.';

describe('BuildPromptHero — import pivot (spec-473)', () => {
  it('ac-1/ac-4/ac-7: leads with the import challenge — the idea-sentence prompt is gone', () => {
    tagAc(`${AC}/ac-1`);
    tagAc(`${AC}/ac-4`);
    tagAc(`${AC}/ac-7`);
    renderHero();

    expect(screen.getByTestId('hero-eyebrow')).toHaveTextContent('Memex');
    expect(screen.getByTestId('hero-greeting')).toHaveTextContent('Hi Alice.');
    // Pivoted copy: the import-first challenge, headline naming the Spec outcome.
    expect(screen.getByTestId('hero-headline')).toHaveTextContent(
      /turn your md doc into a living memex spec/i,
    );
    // Sub-copy invites a pasted/uploaded doc OR a described feature (ac-4 broadening) —
    // both feed the same import path; there is no separate idea input.
    expect(screen.getByTestId('hero-sub')).toHaveTextContent(/paste an md doc/i);
    expect(screen.getByTestId('hero-sub')).toHaveTextContent(/describe a feature/i);
    // The retired spec-470 idea headline must NOT appear.
    expect(screen.queryByText('What do you want to build?')).not.toBeInTheDocument();
    // Import affordances are present: a paste field + an upload control + file input.
    expect(screen.getByTestId('hero-input')).toBeInTheDocument();
    expect(screen.getByTestId('hero-upload')).toBeInTheDocument();
    expect(screen.getByTestId('hero-file-input')).toBeInTheDocument();
    // Prominent worded primary CTA (agreed copy) rather than a bare corner arrow.
    expect(screen.getByTestId('hero-submit')).toHaveTextContent(/turn my doc into a spec/i);
    // The paste field is labelled and has a visible focus ring (a11y, std-27).
    const input = screen.getByLabelText('Paste your spec or markdown to import');
    expect(input).toBe(screen.getByTestId('hero-input'));
    expect(input.className).toContain('focus:ring-2');
  });

  it('ac-2/ac-8: a PASTED document feeds the modal as a document seed', () => {
    tagAc(`${AC}/ac-2`);
    tagAc(`${AC}/ac-8`);
    renderHero();

    fireEvent.change(screen.getByTestId('hero-input'), {
      target: { value: SUBSTANTIAL_DOC },
    });
    fireEvent.click(screen.getByTestId('hero-submit'));

    const modal = screen.getByTestId('new-spec-modal-open');
    expect(modal).toBeInTheDocument();
    // Both the seed text AND the document framing reach the modal (ac-3 handoff).
    expect(modal.getAttribute('data-seed')).toBe(SUBSTANTIAL_DOC);
    expect(modal.getAttribute('data-seed-kind')).toBe('document');
  });

  it('ac-2/ac-8: an uploaded markdown FILE is read in-browser into the same seed', async () => {
    tagAc(`${AC}/ac-2`);
    tagAc(`${AC}/ac-8`);
    renderHero();

    fireEvent.change(screen.getByTestId('hero-file-input'), {
      target: { files: [mdFile(SUBSTANTIAL_DOC, 'presence.md')] },
    });

    // FileReader is async — the paste field fills with the file's text.
    await waitFor(() =>
      expect((screen.getByTestId('hero-input') as HTMLTextAreaElement).value).toBe(
        SUBSTANTIAL_DOC,
      ),
    );
    expect(screen.getByTestId('hero-filename')).toHaveTextContent('presence.md');

    fireEvent.click(screen.getByTestId('hero-submit'));
    const modal = screen.getByTestId('new-spec-modal-open');
    expect(modal.getAttribute('data-seed')).toBe(SUBSTANTIAL_DOC);
    expect(modal.getAttribute('data-seed-kind')).toBe('document');
  });

  it('ac-5/ac-8: an unsupported file type is rejected with an in-hero error and never dispatched', async () => {
    tagAc(`${AC}/ac-5`);
    tagAc(`${AC}/ac-8`);
    renderHero();

    fireEvent.change(screen.getByTestId('hero-file-input'), {
      target: { files: [mdFile('nope', 'contract.pdf', 'application/pdf')] },
    });

    await waitFor(() => expect(screen.getByTestId('hero-error')).toBeInTheDocument());
    expect(screen.getByTestId('hero-error')).toHaveTextContent(/markdown or text file/i);
    // The document never loaded, so submit is a no-op (no modal).
    expect((screen.getByTestId('hero-input') as HTMLTextAreaElement).value).toBe('');
    fireEvent.click(screen.getByTestId('hero-submit'));
    expect(screen.queryByTestId('new-spec-modal-open')).not.toBeInTheDocument();
  });

  it('ac-5/ac-8: an oversized file (>1MB) is rejected with an in-hero error', async () => {
    tagAc(`${AC}/ac-5`);
    tagAc(`${AC}/ac-8`);
    renderHero();

    const big = 'a'.repeat(1024 * 1024 + 1); // just over 1 MB
    fireEvent.change(screen.getByTestId('hero-file-input'), {
      target: { files: [mdFile(big, 'huge.md')] },
    });

    await waitFor(() => expect(screen.getByTestId('hero-error')).toBeInTheDocument());
    expect(screen.getByTestId('hero-error')).toHaveTextContent(/under 1\s?MB/i);
    expect((screen.getByTestId('hero-input') as HTMLTextAreaElement).value).toBe('');
  });

  it('ac-5: empty / whitespace input neither opens the dialog nor dispatches', () => {
    tagAc(`${AC}/ac-5`);
    renderHero();

    // Whitespace only.
    fireEvent.change(screen.getByTestId('hero-input'), { target: { value: '   \n ' } });
    fireEvent.click(screen.getByTestId('hero-submit'));
    expect(screen.queryByTestId('new-spec-modal-open')).not.toBeInTheDocument();
    expect(trackMock.mock.calls.some((c) => c[0] === 'home.import_submitted')).toBe(false);
  });

  it('ac-10: emits import_shown on mount and the funnel on submit, tagged by method', () => {
    tagAc(`${AC}/ac-10`);
    renderHero();

    // Shown once on mount (the funnel denominator).
    expect(trackMock.mock.calls.filter((c) => c[0] === 'home.import_shown')).toHaveLength(1);

    // Paste + submit → import_submitted{method:'paste'} + spec.create_clicked{home_hero}.
    fireEvent.change(screen.getByTestId('hero-input'), { target: { value: SUBSTANTIAL_DOC } });
    fireEvent.click(screen.getByTestId('hero-submit'));

    const submitted = trackMock.mock.calls.find((c) => c[0] === 'home.import_submitted');
    expect(submitted?.[1]).toEqual({ method: 'paste' });
    const createClicked = trackMock.mock.calls.find((c) => c[0] === 'spec.create_clicked');
    expect(createClicked?.[1]).toEqual({ surface: 'home_hero' });
  });

  it("ac-10: a file-provided document tags home.import_submitted with method:'file'", async () => {
    tagAc(`${AC}/ac-10`);
    renderHero();

    fireEvent.change(screen.getByTestId('hero-file-input'), {
      target: { files: [mdFile(SUBSTANTIAL_DOC)] },
    });
    await waitFor(() =>
      expect((screen.getByTestId('hero-input') as HTMLTextAreaElement).value).toBe(SUBSTANTIAL_DOC),
    );
    fireEvent.click(screen.getByTestId('hero-submit'));

    const submitted = trackMock.mock.calls.find((c) => c[0] === 'home.import_submitted');
    expect(submitted?.[1]).toEqual({ method: 'file' });
  });

  it('ac-7: the "Skip to my specs" link still reaches the Specs board', () => {
    tagAc(`${AC}/ac-7`);
    renderHero('/alice/personal/specs');
    fireEvent.click(screen.getByTestId('hero-skip'));
    expect(screen.getByTestId('probe').getAttribute('data-path')).toBe('/alice/personal/specs');
  });
});
