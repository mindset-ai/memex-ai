import { describe, it, expect, vi } from 'vitest';
import { fetchJson } from './fetchJson';
import { ApiError, NotFoundError } from './errors';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('fetchJson', () => {
  it('returns parsed JSON on 2xx', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ ok: true, items: [1, 2] }));
    const out = await fetchJson<{ ok: boolean; items: number[] }>(fetcher, '/x');
    expect(out).toEqual({ ok: true, items: [1, 2] });
    expect(fetcher).toHaveBeenCalledWith('/x', undefined);
  });

  it('throws NotFoundError on 404 by default', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ message: 'gone' }, 404));
    await expect(fetchJson(fetcher, '/x')).rejects.toThrow(NotFoundError);
  });

  it('throws ApiError with status + message on other non-2xx', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ message: 'bad' }, 500));
    try {
      await fetchJson(fetcher, '/x');
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(500);
      expect((err as Error).message).toBe('bad');
    }
  });

  it('uses errorFactory when supplied', async () => {
    class CustomErr extends Error {
      constructor(public status: number) {
        super('custom');
      }
    }
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({}, 418));
    await expect(
      fetchJson(fetcher, '/x', undefined, {
        errorFactory: (status) => new CustomErr(status),
      }),
    ).rejects.toBeInstanceOf(CustomErr);
  });

  it('attaches Authorization header when token is supplied', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({}));
    await fetchJson(fetcher, '/x', { method: 'POST' }, { token: 'abc' });
    expect(fetcher).toHaveBeenCalledWith('/x', {
      method: 'POST',
      headers: { Authorization: 'Bearer abc' },
    });
  });

  it('returns text when asText=true', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response('plain text', { status: 200 }));
    const out = await fetchJson<string>(fetcher, '/x', undefined, { asText: true });
    expect(out).toBe('plain text');
  });

  it('falls back to body.error when message is missing', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: 'fallback' }, 500));
    await expect(fetchJson(fetcher, '/x')).rejects.toThrow('fallback');
  });

  it('handles non-JSON error bodies gracefully', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response('not json', { status: 500 }));
    await expect(fetchJson(fetcher, '/x')).rejects.toThrow('Request failed: 500');
  });
});
