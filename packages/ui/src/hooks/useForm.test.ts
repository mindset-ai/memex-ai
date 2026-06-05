import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useForm } from './useForm';

describe('useForm', () => {
  it('returns initial values + idle state', () => {
    const { result } = renderHook(() =>
      useForm({ initial: { email: '', password: '' }, onSubmit: vi.fn() }),
    );
    expect(result.current.values).toEqual({ email: '', password: '' });
    expect(result.current.submitting).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('setField updates a single field without disturbing others', () => {
    const { result } = renderHook(() =>
      useForm({
        initial: { email: '', password: '' },
        onSubmit: vi.fn(),
      }),
    );
    act(() => result.current.setField('email', 'alice@example.com'));
    expect(result.current.values).toEqual({
      email: 'alice@example.com',
      password: '',
    });
  });

  it('setValues merges a partial update', () => {
    const { result } = renderHook(() =>
      useForm({ initial: { a: '1', b: '2', c: '3' }, onSubmit: vi.fn() }),
    );
    act(() => result.current.setValues({ b: 'X' }));
    expect(result.current.values).toEqual({ a: '1', b: 'X', c: '3' });
  });

  it('submit awaits onSubmit and toggles submitting around it', async () => {
    let resolveOnSubmit: () => void;
    const onSubmit = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveOnSubmit = resolve;
        }),
    );
    const { result } = renderHook(() => useForm({ initial: { x: '' }, onSubmit }));

    let submitPromise: Promise<void>;
    act(() => {
      submitPromise = result.current.submit();
    });

    await waitFor(() => expect(result.current.submitting).toBe(true));
    expect(onSubmit).toHaveBeenCalledWith({ x: '' });

    act(() => resolveOnSubmit());
    await act(async () => {
      await submitPromise;
    });

    expect(result.current.submitting).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('captures errors and surfaces them via `error`', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useForm({ initial: { x: '' }, onSubmit }));

    await act(async () => {
      await result.current.submit();
    });

    expect(result.current.error).toBe('boom');
    expect(result.current.submitting).toBe(false);
  });

  it('honours a custom onError formatter', async () => {
    const onSubmit = vi.fn().mockRejectedValue({ status: 400, code: 'bad' });
    const { result } = renderHook(() =>
      useForm({
        initial: { x: '' },
        onSubmit,
        onError: (err) => `[${(err as { status: number }).status}]`,
      }),
    );
    await act(async () => {
      await result.current.submit();
    });
    expect(result.current.error).toBe('[400]');
  });

  it('preventDefault is called when the submit event is supplied', async () => {
    const preventDefault = vi.fn();
    const { result } = renderHook(() =>
      useForm({ initial: { x: '' }, onSubmit: vi.fn() }),
    );
    await act(async () => {
      await result.current.submit({ preventDefault });
    });
    expect(preventDefault).toHaveBeenCalled();
  });

  it('reset() restores initial values and clears state', async () => {
    const { result } = renderHook(() =>
      useForm({
        initial: { x: '' },
        onSubmit: vi.fn().mockRejectedValue(new Error('boom')),
      }),
    );
    act(() => result.current.setField('x', 'changed'));
    await act(async () => {
      await result.current.submit();
    });
    expect(result.current.error).toBe('boom');

    act(() => result.current.reset());
    expect(result.current.values).toEqual({ x: '' });
    expect(result.current.error).toBeNull();
    expect(result.current.submitting).toBe(false);
  });
});
