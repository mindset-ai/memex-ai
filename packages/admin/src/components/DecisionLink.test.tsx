import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import {
  DecisionLink,
  formatDecisionCiteLabel,
  parseDecisionRefs,
  _resetParentDocTypeCacheForTesting,
} from './DecisionLink';

const fetchDecisionByHandleMock = vi.fn();
const fetchDocMock = vi.fn();
vi.mock('../api/client', () => {
  // Defined inside the factory because vi.mock is hoisted above all top-level
  // bindings. The component does `instanceof NotFoundError` — the test below
  // re-imports this same class (after the mock applies) so the rejected error
  // *is* an instance of the class the component checks against.
  class NotFoundError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'NotFoundError';
    }
  }
  return {
    fetchDecisionByHandle: (...args: unknown[]) => fetchDecisionByHandleMock(...args),
    fetchDoc: (...args: unknown[]) => fetchDocMock(...args),
    NotFoundError,
  };
});

// Re-import the mocked class so the test can construct rejection values that
// are real instances of the same class the component checks against.
async function getMockedNotFoundError(): Promise<typeof Error> {
  const mod = await import('../api/client');
  return mod.NotFoundError as unknown as typeof Error;
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetParentDocTypeCacheForTesting();
});

describe('parseDecisionRefs', () => {
  it('returns the original string as a single text segment when no refs are present', () => {
    expect(parseDecisionRefs('Plain text with no decision refs.')).toEqual([
      { kind: 'text', value: 'Plain text with no decision refs.' },
    ]);
  });

  it('extracts a single [per dec-N] reference', () => {
    expect(parseDecisionRefs('Use ArgoCD [per dec-7] for deploy.')).toEqual([
      { kind: 'text', value: 'Use ArgoCD ' },
      { kind: 'ref', value: 'dec-7' },
      { kind: 'text', value: ' for deploy.' },
    ]);
  });

  it('extracts multiple references in source order', () => {
    expect(
      parseDecisionRefs('first [per dec-1] middle [per dec-42] last'),
    ).toEqual([
      { kind: 'text', value: 'first ' },
      { kind: 'ref', value: 'dec-1' },
      { kind: 'text', value: ' middle ' },
      { kind: 'ref', value: 'dec-42' },
      { kind: 'text', value: ' last' },
    ]);
  });

  it('handles back-to-back references', () => {
    expect(parseDecisionRefs('[per dec-1][per dec-2]')).toEqual([
      { kind: 'ref', value: 'dec-1' },
      { kind: 'ref', value: 'dec-2' },
    ]);
  });

  it('does NOT match malformed references', () => {
    // Wrong prefix (`per` is required), wrong handle shape, wrong brackets — all
    // pass through as plain text.
    expect(parseDecisionRefs('see [from dec-1] and [per task-2]')).toEqual([
      { kind: 'text', value: 'see [from dec-1] and [per task-2]' },
    ]);
  });

  it('is stateless across calls (regex `lastIndex` is reset)', () => {
    // A naive global-regex implementation can leak `lastIndex` between calls.
    // Run the same content twice and verify identical output.
    const a = parseDecisionRefs('one [per dec-3] two');
    const b = parseDecisionRefs('one [per dec-3] two');
    expect(a).toEqual(b);
    expect(a).toHaveLength(3);
  });

  // t-7: parser accepts the new canonical Spec cite alongside legacy forms.
  it('extracts the new `[per mis-N:dec-M]` Spec cite', () => {
    expect(parseDecisionRefs('See [per mis-3:dec-7] for the rationale.')).toEqual([
      { kind: 'text', value: 'See ' },
      { kind: 'ref', value: 'mis-3:dec-7' },
      { kind: 'text', value: ' for the rationale.' },
    ]);
  });

  it('extracts the legacy `[per doc-N:dec-M]` qualified cite', () => {
    expect(parseDecisionRefs('Per [per doc-2:dec-1] we ship.')).toEqual([
      { kind: 'text', value: 'Per ' },
      { kind: 'ref', value: 'doc-2:dec-1' },
      { kind: 'text', value: ' we ship.' },
    ]);
  });

  it('mixes mis-, doc-, and bare forms in one piece of content', () => {
    expect(
      parseDecisionRefs('a [per mis-1:dec-2] b [per doc-3:dec-4] c [per dec-5]'),
    ).toEqual([
      { kind: 'text', value: 'a ' },
      { kind: 'ref', value: 'mis-1:dec-2' },
      { kind: 'text', value: ' b ' },
      { kind: 'ref', value: 'doc-3:dec-4' },
      { kind: 'text', value: ' c ' },
      { kind: 'ref', value: 'dec-5' },
    ]);
  });
});

// t-7: pure label-formatter — the auto-upgrade rule expressed without React.
// Used by the DecisionLink display layer to rewrite legacy `doc-N:dec-M` cites
// to the canonical `mis-N:dec-M` form when the parent doc is a Spec. The
// `mis-` prefix in the standards-cite output is preserved as-is — the parser
// (and standards content) tolerate the legacy spelling (it predates the
// b-105 brief→spec rename).
describe('formatDecisionCiteLabel (t-7)', () => {
  it('upgrades `doc-N:dec-M` to `mis-N:dec-M` when parent is a Spec', () => {
    expect(formatDecisionCiteLabel('doc-3:dec-7', 'spec')).toBe('mis-3:dec-7');
  });

  it('leaves `doc-N:dec-M` verbatim when parent is a legacy `brief` (post-b-105: brief is no longer a Spec docType)', () => {
    // After the b-105 brief→spec rename, the SPEC_DOC_TYPES set only contains
    // 'spec'. Any leftover `'brief'` rows are pre-migration data and the
    // display layer no longer treats them as Specs.
    expect(formatDecisionCiteLabel('doc-3:dec-7', 'brief')).toBe('doc-3:dec-7');
  });

  it('leaves `doc-N:dec-M` verbatim when parent is a Standard', () => {
    expect(formatDecisionCiteLabel('doc-3:dec-7', 'standard')).toBe('doc-3:dec-7');
  });

  it('leaves `doc-N:dec-M` verbatim when parent docType is unknown', () => {
    expect(formatDecisionCiteLabel('doc-3:dec-7', null)).toBe('doc-3:dec-7');
  });

  it('leaves `mis-N:dec-M` verbatim (already canonical)', () => {
    expect(formatDecisionCiteLabel('mis-3:dec-7', 'spec')).toBe('mis-3:dec-7');
  });

  it('leaves bare `dec-N` verbatim (no parent in the cite to upgrade)', () => {
    expect(formatDecisionCiteLabel('dec-7', 'spec')).toBe('dec-7');
  });
});

// Tiny route observer that lets a test assert the post-navigate location.
function LocationProbe() {
  const loc = useLocation();
  return (
    <div data-testid="location">
      {loc.pathname}
      {loc.search}
    </div>
  );
}

describe('DecisionLink', () => {
  it('renders the handle label inside a button', () => {
    render(
      <MemoryRouter>
        <DecisionLink handle="dec-7" />
      </MemoryRouter>,
    );
    const link = screen.getByTestId('decision-link');
    expect(link).toHaveTextContent('dec-7');
    expect(link).toHaveAttribute('data-decision-handle', 'dec-7');
  });

  it('navigates to the parent doc with ?decision=dec-N on click', async () => {
    const user = userEvent.setup();
    fetchDecisionByHandleMock.mockResolvedValueOnce({
      id: 'dec-uuid-1',
      docId: 'parent-doc-uuid',
      seq: 7,
      title: 'Use ArgoCD',
      context: null,
      status: 'resolved',
      resolution: 'go for it',
      resolvedAt: '2025-01-01T00:00:00Z',
      createdAt: '2025-01-01T00:00:00Z',
      options: null,
      chosenOptionIndex: null,
    });

    render(
      <MemoryRouter initialEntries={['/standards/bp-1']}>
        <Routes>
          <Route
            path="/standards/:id"
            element={<DecisionLink handle="dec-7" />}
          />
          <Route path="/docs/:id" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByTestId('decision-link'));

    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent(
        '/docs/parent-doc-uuid?decision=dec-7',
      );
    });
    // b-42 t-2: fetchDecisionByHandle takes an optional parentDocId 2nd arg for
    // bare-handle scoping. No parentDocId is passed to this DecisionLink, so it
    // resolves to undefined.
    expect(fetchDecisionByHandleMock).toHaveBeenCalledWith('dec-7', undefined);
  });

  it('shows an error tooltip without navigating when the handle is unresolved', async () => {
    const user = userEvent.setup();
    const NotFoundError = await getMockedNotFoundError();
    fetchDecisionByHandleMock.mockRejectedValueOnce(
      new NotFoundError('dec-99 not found'),
    );

    render(
      <MemoryRouter initialEntries={['/standards/bp-1']}>
        <Routes>
          <Route
            path="/standards/:id"
            element={<DecisionLink handle="dec-99" />}
          />
          <Route path="/docs/:id" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByTestId('decision-link'));

    await waitFor(() => {
      const link = screen.getByTestId('decision-link');
      expect(link).toHaveAttribute('title', expect.stringContaining('not found'));
    });
    // Still on the standard route — no navigation happened.
    expect(screen.queryByTestId('location')).not.toBeInTheDocument();
  });

  // t-7 display upgrade — legacy `[per doc-N:dec-M]` cites in source content
  // are auto-upgraded to the canonical `[per mis-N:dec-M]` label when the
  // parent doc is a Spec. Source content stays untouched (data attribute
  // preserves the original handle); only the visible label flips.
  it('upgrades a legacy `doc-N:dec-M` cite to `mis-N:dec-M` when the parent is a Spec', async () => {
    fetchDocMock.mockResolvedValueOnce({
      id: 'spec-uuid',
      handle: 'doc-3',
      title: 'A Spec',
      docType: 'spec',
      status: 'draft',
    });

    render(
      <MemoryRouter>
        <DecisionLink handle="doc-3:dec-7" />
      </MemoryRouter>,
    );

    // Initial paint shows the source label verbatim — the upgrade is async.
    const link = screen.getByTestId('decision-link');
    expect(link).toHaveTextContent('doc-3:dec-7');

    await waitFor(() => {
      expect(screen.getByTestId('decision-link')).toHaveTextContent('mis-3:dec-7');
    });
    // Data attribute keeps the source handle so click handlers / analytics
    // can still trace back to the verbatim cite from standard content.
    expect(link).toHaveAttribute('data-decision-handle', 'doc-3:dec-7');
    expect(link).toHaveAttribute('data-decision-display', 'mis-3:dec-7');
    expect(fetchDocMock).toHaveBeenCalledWith('doc-3');
  });

  it('does NOT upgrade `doc-N:dec-M` when the parent is a Standard', async () => {
    fetchDocMock.mockResolvedValueOnce({
      id: 'bp-uuid',
      handle: 'doc-4',
      title: 'A Standard',
      docType: 'standard',
      status: 'draft',
    });

    render(
      <MemoryRouter>
        <DecisionLink handle="doc-4:dec-1" />
      </MemoryRouter>,
    );

    // Wait for the lookup to settle, then assert the label is still the
    // legacy form (no upgrade because the parent isn't a Spec).
    await waitFor(() => {
      expect(fetchDocMock).toHaveBeenCalledWith('doc-4');
    });
    expect(screen.getByTestId('decision-link')).toHaveTextContent('doc-4:dec-1');
  });

  it('skips the parent-docType fetch entirely for `mis-N:dec-M` (already canonical)', async () => {
    render(
      <MemoryRouter>
        <DecisionLink handle="mis-3:dec-7" />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('decision-link')).toHaveTextContent('mis-3:dec-7');
    // No round-trip needed for already-canonical cites — keeps initial paint cheap
    // when standards adopt the new form.
    expect(fetchDocMock).not.toHaveBeenCalled();
  });

  it('skips the parent-docType fetch entirely for bare `dec-N`', async () => {
    render(
      <MemoryRouter>
        <DecisionLink handle="dec-7" />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('decision-link')).toHaveTextContent('dec-7');
    expect(fetchDocMock).not.toHaveBeenCalled();
  });
});
