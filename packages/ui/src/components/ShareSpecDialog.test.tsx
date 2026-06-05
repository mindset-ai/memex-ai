// The header Share dialog — the Spec's canonical URL with a Copy button
// (replaced the "Coming soon" placeholder).

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ShareSpecDialog } from './ShareSpecDialog';

const URL = 'https://memex.ai/mindset-prod/memex-building-itself/specs/spec-159';

describe('ShareSpecDialog', () => {
  it('shows the spec URL; Copy writes it to the clipboard and confirms', async () => {
    const user = userEvent.setup();
    render(<ShareSpecDialog url={URL} onClose={vi.fn()} />);

    // The link is on screen, selectable.
    const input = screen.getByRole('textbox', { name: 'Link to this spec' });
    expect(input).toHaveValue(URL);
    expect(input).toHaveAttribute('readonly');

    await user.click(screen.getByRole('button', { name: 'Copy' }));
    // Transient confirmation + the URL actually landed on the clipboard
    // (userEvent stubs the async clipboard API).
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    await expect(window.navigator.clipboard.readText()).resolves.toBe(URL);
  });

  it('Escape and the close button both dismiss', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<ShareSpecDialog url={URL} onClose={onClose} />);

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('falls back to a manual-copy hint when the clipboard write is blocked', async () => {
    const user = userEvent.setup();
    render(<ShareSpecDialog url={URL} onClose={vi.fn()} />);

    vi.spyOn(window.navigator.clipboard, 'writeText').mockRejectedValueOnce(
      new Error('NotAllowedError'),
    );
    await user.click(screen.getByRole('button', { name: 'Copy' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/copy it manually/);
    // No false "Copied" confirmation.
    expect(screen.queryByRole('button', { name: 'Copied' })).not.toBeInTheDocument();
  });
});
