import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useConsumeToken } from './useConsumeToken';

function setUrl(search: string) {
  // jsdom URL is read-only via location.assign; replace via History API.
  window.history.replaceState({}, '', `/${search}`);
}

describe('useConsumeToken', () => {
  beforeEach(() => setUrl(''));
  afterEach(() => setUrl(''));

  it('starts in `error` when no token is present and auto=true', async () => {
    setUrl('');
    const { result } = renderHook(() =>
      useConsumeToken({ consume: vi.fn().mockResolvedValue('ok') }),
    );
    await waitFor(() => expect(result.current.stage).toBe('error'));
    expect(result.current.error).toMatch(/Missing token/);
  });

  it('runs through verifying → success when consume resolves', async () => {
    setUrl('?token=abc');
    const consume = vi.fn().mockResolvedValue({ session: 'fresh' });
    const onSuccess = vi.fn();
    const { result } = renderHook(() =>
      useConsumeToken({ consume, onSuccess }),
    );

    await waitFor(() => expect(result.current.stage).toBe('success'));
    expect(consume).toHaveBeenCalledWith('abc');
    expect(result.current.result).toEqual({ session: 'fresh' });
    expect(onSuccess).toHaveBeenCalledWith({ session: 'fresh' });
  });

  it('transitions to `error` when consume rejects', async () => {
    setUrl('?token=abc');
    const consume = vi.fn().mockRejectedValue(new Error('expired'));
    const { result } = renderHook(() => useConsumeToken({ consume }));

    await waitFor(() => expect(result.current.stage).toBe('error'));
    expect(result.current.error).toBe('expired');
    expect(result.current.result).toBeNull();
  });

  it('honours a custom paramKey', async () => {
    setUrl('?inviteCode=xyz');
    const consume = vi.fn().mockResolvedValue('ok');
    renderHook(() => useConsumeToken({ paramKey: 'inviteCode', consume }));
    await waitFor(() => expect(consume).toHaveBeenCalledWith('xyz'));
  });

  it('does NOT auto-run when auto=false until start() is called', async () => {
    setUrl('?token=abc');
    const consume = vi.fn().mockResolvedValue('ok');
    const { result } = renderHook(() =>
      useConsumeToken({ consume, auto: false }),
    );

    expect(consume).not.toHaveBeenCalled();
    expect(result.current.stage).toBe('idle');

    result.current.start();
    await waitFor(() => expect(consume).toHaveBeenCalled());
  });
});
