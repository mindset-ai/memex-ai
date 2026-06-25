// spec-171 — Plan & seats screen seat input (ac-21, ac-28).
//
//   ac-21 : accepts seat ≥1 with no upper-bound validation; entering 0 shows a
//           validation error.
//   ac-28 : the seat input has NO max attribute; any positive integer is
//           accepted (no hard cap).
//
// TAGGED suite — POSTs AC events to PROD memex.ai on completion (per the repo's
// tagged-test convention). Verify locally via tsc / the build; a human/agent
// runs the tagged suite with MEMEX_EMIT_KEY set.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import { UpgradeSeats } from './UpgradeSeats';

const AC_21 = 'mindset-prod/memex-building-itself/specs/spec-171/acs/ac-21';
const AC_28 = 'mindset-prod/memex-building-itself/specs/spec-171/acs/ac-28';

// The component only needs a token from useAuth and startCheckout from the client;
// neither is exercised by these input-validation assertions.
vi.mock('../../components/AuthContext', () => ({
  useAuth: () => ({ token: 'test-token' }),
}));
vi.mock('../../api/client', () => ({
  startCheckout: vi.fn(),
}));

function renderSeats(plan = 'premium') {
  return render(
    <MemoryRouter initialEntries={[`/upgrade/${plan}`]}>
      <Routes>
        <Route path="/upgrade/:plan" element={<UpgradeSeats />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('spec-171 ac-21: seat count ≥1; entering 0 shows a validation error', () => {
  it('defaults to a valid seat count with no error shown', () => {
    tagAc(AC_21);
    renderSeats();
    const input = screen.getByLabelText(/number of seats/i) as HTMLInputElement;
    expect(input.value).toBe('1');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('entering 0 surfaces a visible validation error', () => {
    tagAc(AC_21);
    renderSeats();
    const input = screen.getByLabelText(/number of seats/i);

    // Controlled <input type=number> — set the value in one shot.
    fireEvent.change(input, { target: { value: '0' } });

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/at least 1 seat/i);
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('spec-171 ac-28: seat input has no max attribute; accepts any positive integer', () => {
  it('the seat input declares no max attribute (no hard cap)', () => {
    tagAc(AC_28);
    renderSeats();
    const input = screen.getByLabelText(/number of seats/i);
    expect(input).not.toHaveAttribute('max');
    // min is 1 (≥1 floor per ac-21) — that's the only bound.
    expect(input).toHaveAttribute('min', '1');
  });

  it('accepts a large seat count (e.g. 9999) with no error', () => {
    tagAc(AC_28);
    renderSeats();
    const input = screen.getByLabelText(/number of seats/i) as HTMLInputElement;

    fireEvent.change(input, { target: { value: '9999' } });

    expect(input.value).toBe('9999');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
