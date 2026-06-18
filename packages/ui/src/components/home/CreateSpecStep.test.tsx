// spec-305 — the create-spec step (copy-paste prompt + BYO PRD / sample, dec-9).
// ac-14 — the card presents a prompt + a built-in sample, and uploads nothing.
// ac-4  — the canvas self-advances the moment the spec exists (hasSpec).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';

const fetchJourneyStateApi = vi.hoisted(() => vi.fn());
vi.mock('../../api/journey', () => ({ fetchJourneyStateApi }));

import { CreateSpecStep } from './CreateSpecStep';
const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-305/acs/ac-${n}`;

beforeEach(() => {
  fetchJourneyStateApi.mockReset();
  fetchJourneyStateApi.mockResolvedValue({ milestones: { hasSpec: false } });
});

describe('CreateSpecStep', () => {
  it('defaults to the sample prompt and can switch to a BYO-PRD prompt', () => {
    tagAc(AC(14));
    render(<CreateSpecStep preview />);
    expect(screen.getByTestId('journey-step-create-spec')).toBeInTheDocument();
    expect(screen.getByTestId('create-spec-prompt').textContent).toMatch(/Orders Dashboard/);
    fireEvent.click(screen.getByTestId('source-prd'));
    expect(screen.getByTestId('create-spec-prompt').textContent).toMatch(/PRD/);
    // no file input — the agent reads the source locally (no Memex-side upload).
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it('advances the moment the spec exists (hasSpec)', async () => {
    tagAc(AC(4));
    fetchJourneyStateApi.mockResolvedValue({ milestones: { hasSpec: true } });
    const onComplete = vi.fn();
    render(<CreateSpecStep onComplete={onComplete} />);
    expect(await screen.findByTestId('create-spec-done')).toBeInTheDocument();
    await waitFor(() => expect(onComplete).toHaveBeenCalled(), { timeout: 2500 });
  });
});
