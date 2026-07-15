import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';

// spec-479 t-6 — the fetch-and-decide logic behind the stale-tenant forward.
// The end-to-end forward (TenantLayout navigating a renamed memex's old URL to
// the new one) is exercised by journey-61 in CI; this proves the hook's
// contract locally.
const AC = 'mindset-prod/memex-building-itself/specs/spec-479/acs/ac-11';

const resolveTenantRedirectApi = vi.fn();
vi.mock('../api/client', () => ({
  resolveTenantRedirectApi: (...a: unknown[]) => resolveTenantRedirectApi(...a),
}));

import { useStaleTenantForward } from './useStaleTenantForward';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useStaleTenantForward (spec-479 t-6)', () => {
  it('stays idle and never fetches when disabled', () => {
    tagAc(AC);
    const { result } = renderHook(() =>
      useStaleTenantForward('/ns/old/specs/spec-1', false),
    );
    expect(result.current.state).toBe('idle');
    expect(resolveTenantRedirectApi).not.toHaveBeenCalled();
  });

  it('resolves to the forwarded path on a hit', async () => {
    tagAc(AC);
    resolveTenantRedirectApi.mockResolvedValue('/ns/new/specs/spec-1');
    const { result } = renderHook(() =>
      useStaleTenantForward('/ns/old/specs/spec-1', true),
    );
    expect(result.current.state).toBe('loading');
    await waitFor(() => expect(result.current.state).toBe('done'));
    expect(result.current.to).toBe('/ns/new/specs/spec-1');
    expect(resolveTenantRedirectApi).toHaveBeenCalledWith('/ns/old/specs/spec-1');
  });

  it('resolves to null (caller falls through) on a miss', async () => {
    tagAc(AC);
    resolveTenantRedirectApi.mockResolvedValue(null);
    const { result } = renderHook(() =>
      useStaleTenantForward('/ns/old/specs/spec-1', true),
    );
    await waitFor(() => expect(result.current.state).toBe('done'));
    expect(result.current.to).toBeNull();
  });
});
