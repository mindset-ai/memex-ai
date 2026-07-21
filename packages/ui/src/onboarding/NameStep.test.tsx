import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { NameStep } from './NameStep';

// spec-502:
//   ac-2  (scope) — the wizard names the Memex in one pre-filled step.
//   ac-12 (impl)  — memex-name only, no org control anywhere.
const AC_NAME = 'mindset-prod/memex-building-itself/specs/spec-502/acs/ac-12';
const AC_NO_ORG = 'mindset-prod/memex-building-itself/specs/spec-502/acs/ac-12';

describe('spec-502 NameStep', () => {
  it('ac-2: pre-fills the name field and is editable', () => {
    tagAc(AC_NAME);
    render(<NameStep defaultName="my-codebase" onSubmit={() => {}} />);
    const input = screen.getByTestId('wizard-memex-name') as HTMLInputElement;
    expect(input.value).toBe('my-codebase');
    fireEvent.change(input, { target: { value: 'renamed-memex' } });
    expect(input.value).toBe('renamed-memex');
  });

  it('ac-2: submits the (edited, trimmed) name', () => {
    tagAc(AC_NAME);
    const onSubmit = vi.fn();
    render(<NameStep defaultName="x" onSubmit={onSubmit} />);
    fireEvent.change(screen.getByTestId('wizard-memex-name'), {
      target: { value: '  chosen-name  ' },
    });
    fireEvent.click(screen.getByTestId('wizard-name-continue'));
    expect(onSubmit).toHaveBeenCalledWith('chosen-name');
  });

  it('ac-12: renders exactly one text field and NO org control', () => {
    tagAc(AC_NO_ORG);
    render(<NameStep defaultName="x" onSubmit={() => {}} />);
    // Exactly one textbox — the memex name.
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    // No org creation/selection anywhere in copy or controls.
    expect(screen.queryByText(/\borg\b|organization|organisation/i)).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('ac-2: does not submit an empty name', () => {
    tagAc(AC_NAME);
    const onSubmit = vi.fn();
    render(<NameStep defaultName="x" onSubmit={onSubmit} />);
    fireEvent.change(screen.getByTestId('wizard-memex-name'), { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('wizard-name-continue'));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
