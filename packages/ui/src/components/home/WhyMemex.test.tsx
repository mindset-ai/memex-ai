// spec-305 — the interactive "Why Memex?" node-graph (three pains → synthesis).
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WhyMemex } from './WhyMemex';

describe('WhyMemex', () => {
  it('reveals a pain explanation on node click', () => {
    render(<WhyMemex onNavigate={vi.fn()} />);
    expect(screen.getByTestId('journey-step-why-memex')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('why-node-docs'));
    expect(screen.getByTestId('why-memex-panel').textContent).toMatch(/markdown|rot/);
  });
  it('lights the synthesis once all three pains are explored', () => {
    render(<WhyMemex onNavigate={vi.fn()} />);
    expect(screen.queryByTestId('why-memex-synthesis')).toBeNull();
    fireEvent.click(screen.getByTestId('why-node-docs'));
    fireEvent.click(screen.getByTestId('why-node-drift'));
    fireEvent.click(screen.getByTestId('why-node-trust'));
    expect(screen.getByTestId('why-memex-synthesis')).toBeInTheDocument();
  });
  it('navigates to the journey on Get started and back on Back', () => {
    const onNavigate = vi.fn();
    render(<WhyMemex onNavigate={onNavigate} />);
    fireEvent.click(screen.getByTestId('why-memex-start'));
    expect(onNavigate).toHaveBeenCalledWith('identity');
    fireEvent.click(screen.getByTestId('why-memex-back'));
    expect(onNavigate).toHaveBeenCalledWith('welcome');
  });
});
