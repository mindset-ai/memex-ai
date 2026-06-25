import { describe, it, expect, beforeEach } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TelemetryOptOut } from './TelemetryOptOut';

const AC = 'mindset-prod/memex-building-itself/specs/spec-244/acs';

beforeEach(() => {
  localStorage.clear();
});

describe('TelemetryOptOut — the consent control (ac-7)', () => {
  it('defaults to sharing-on and persists an opt-out when toggled off', () => {
    tagAc(`${AC}/ac-7`);
    render(<TelemetryOptOut />);
    const toggle = screen.getByTestId('telemetry-toggle') as HTMLInputElement;
    expect(toggle.checked).toBe(true); // sharing on by default
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(false);
    expect(localStorage.getItem('memex.telemetry.optout')).toBe('1');
    // The copy states the privacy posture plainly.
    expect(screen.getByText(/no document content/i)).toBeInTheDocument();
  });

  it('re-checking clears the opt-out', () => {
    tagAc(`${AC}/ac-7`);
    localStorage.setItem('memex.telemetry.optout', '1');
    render(<TelemetryOptOut />);
    const toggle = screen.getByTestId('telemetry-toggle') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect(localStorage.getItem('memex.telemetry.optout')).toBeNull();
  });
});
