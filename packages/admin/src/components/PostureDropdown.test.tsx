// spec-159 ac-19 (amended) — the header posture pill. MY mode on the Spec
// (Editing / Reviewing), Google-Docs style: the pill names the current mode,
// the menu offers both with a check on the current one, and selecting the
// OTHER mode fires onSelect with the target role. Selecting the current mode
// just closes the menu.

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { tagAc } from '@memex-ai-ac/vitest';
import { PostureDropdown } from './PostureDropdown';

const AC19 = 'mindset-prod/memex-building-itself/specs/spec-159/acs/ac-19';

describe('PostureDropdown', () => {
  it('reviewer: pill reads "You are reviewing"; menu checks Reviewing; picking Editing selects editor', async () => {
    tagAc(AC19);
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<PostureDropdown myRole="reviewer" onSelect={onSelect} />);

    const pill = screen.getByRole('button', { name: /You are reviewing/ });
    await user.click(pill);

    // Both modes on offer, check on the current one.
    const editing = screen.getByRole('menuitemradio', { name: /Editing/ });
    const reviewing = screen.getByRole('menuitemradio', { name: /Reviewing/ });
    expect(reviewing).toHaveAttribute('aria-checked', 'true');
    expect(editing).toHaveAttribute('aria-checked', 'false');

    await user.click(editing);
    expect(onSelect).toHaveBeenCalledWith('editor');
    // Menu closes on selection.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('editor: pill reads "You are editing"; picking Reviewing selects reviewer', async () => {
    tagAc(AC19);
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<PostureDropdown myRole="editor" onSelect={onSelect} />);

    await user.click(screen.getByRole('button', { name: /You are editing/ }));
    expect(screen.getByRole('menuitemradio', { name: /Editing/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    await user.click(screen.getByRole('menuitemradio', { name: /Reviewing/ }));
    expect(onSelect).toHaveBeenCalledWith('reviewer');
  });

  it('selecting the CURRENT mode closes the menu without firing onSelect', async () => {
    tagAc(AC19);
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<PostureDropdown myRole="reviewer" onSelect={onSelect} />);

    await user.click(screen.getByRole('button', { name: /You are reviewing/ }));
    await user.click(screen.getByRole('menuitemradio', { name: /Reviewing/ }));

    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('Escape dismisses the menu', async () => {
    tagAc(AC19);
    const user = userEvent.setup();
    render(<PostureDropdown myRole="editor" onSelect={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /You are editing/ }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
