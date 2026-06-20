// spec-305 — the aha: an AC going green from a real test (acVerified, dec-8).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';

const fetchJourneyStateApi = vi.hoisted(() => vi.fn());
vi.mock('../../api/journey', () => ({ fetchJourneyStateApi }));
import { SeeGreenStep } from './SeeGreenStep';
const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-305/acs/ac-${n}`;

beforeEach(() => {
  fetchJourneyStateApi.mockReset();
  fetchJourneyStateApi.mockResolvedValue({ milestones: { acVerified: false } });
});

describe('SeeGreenStep', () => {
  it('shows the prompt + waiting state before green', () => {
    tagAc(AC(5));
    render(<SeeGreenStep preview />);
    expect(screen.getByTestId('journey-step-see-green')).toBeInTheDocument();
    expect(screen.getByTestId('see-green-prompt')).toBeInTheDocument();
  });
  it('celebrates + advances when the AC goes green (acVerified)', async () => {
    tagAc(AC(5));
    fetchJourneyStateApi.mockResolvedValue({ milestones: { acVerified: true } });
    const onComplete = vi.fn();
    render(<SeeGreenStep onComplete={onComplete} />);
    expect(await screen.findByTestId('see-green-done')).toBeInTheDocument();
    await waitFor(() => expect(onComplete).toHaveBeenCalled(), { timeout: 3000 });
  });
});
