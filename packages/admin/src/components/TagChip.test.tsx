import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TagChip } from './TagChip';
import { tagAc } from '@memex-ai-ac/vitest';

// spec-136 t-5 / ac-4: a scoped tag renders the scope visually distinct from the
// value; a flat tag renders plain (no scope segment). Tag text is user input and
// must render escaped — React text children handle this, asserted below.
//
// This file is TAGGED (tagAc) — it POSTs an AC pass/fail event to PROD memex.ai
// on completion. Do NOT run it from an automated process; a human runs the
// tagged suite. Verify the implementation with `npx tsc --noEmit`, the build,
// and the UNTAGGED suites only.
describe('TagChip', () => {
  it('renders a scoped chip with scope distinct from value', () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-136/acs/ac-4');

    render(<TagChip tag={{ scope: 'priority', value: 'high' }} />);

    const chip = screen.getByTestId('tag-chip');
    // Marked as scoped for downstream styling/queries.
    expect(chip.getAttribute('data-tag-scoped')).toBe('true');

    // Scope is rendered in its own element, separate from the value.
    const scope = screen.getByTestId('tag-chip-scope');
    const value = screen.getByTestId('tag-chip-value');
    expect(scope.textContent).toBe('priority');
    expect(value.textContent).toBe('high');
    expect(scope).not.toBe(value);

    // The visible chip text reads `priority::high` (scope + separator + value).
    expect(chip.textContent).toContain('priority');
    expect(chip.textContent).toContain('high');
    expect(chip.textContent).toContain('::');
  });

  it('renders a flat chip plain — no scope segment, no separator', () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-136/acs/ac-4');

    render(<TagChip tag={{ scope: null, value: 'bug' }} />);

    const chip = screen.getByTestId('tag-chip');
    expect(chip.getAttribute('data-tag-scoped')).toBe('false');

    // No scope element for a flat tag.
    expect(screen.queryByTestId('tag-chip-scope')).not.toBeInTheDocument();

    const value = screen.getByTestId('tag-chip-value');
    expect(value.textContent).toBe('bug');
    // Flat chip shows just the value — no `::` separator.
    expect(chip.textContent).toBe('bug');
  });

  it('renders tag text escaped (user input is not interpreted as HTML)', () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-136/acs/ac-4');

    const malicious = '<img src=x onerror=alert(1)>';
    render(<TagChip tag={{ scope: null, value: malicious }} />);

    const value = screen.getByTestId('tag-chip-value');
    // The literal string is the text content; no <img> node was created.
    expect(value.textContent).toBe(malicious);
    expect(value.querySelector('img')).toBeNull();
  });
});
