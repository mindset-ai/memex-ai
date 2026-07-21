// The tokens fetch inside useDesktopMcpStatus must be BOUNDED. Under a
// saturated per-origin connection pool (SSE streams churning against the dev
// proxy) the GET can be queued indefinitely; without a timeout the hook's
// Promise.all never settles and the install surface shows "Checking MCP
// status…" forever. The contract: each attempt is aborted after a timeout
// (freeing its connection slot), bounded retries follow, and the terminal
// failure is an honest 'error' phase, never an eternal 'loading'.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import {
  useDesktopMcpStatus,
  TOKENS_FETCH_TIMEOUT_MS,
  TOKENS_FETCH_ATTEMPTS,
} from './useDesktopMcpStatus';

vi.mock('../components/AuthContext', () => ({ useAuth: () => ({ token: 'test-token' }) }));
vi.mock('../hooks/useUserChangeStream', () => ({ useUserChangeStream: () => {} }));

const listMcpTokensApi = vi.fn();
vi.mock('../api/mcp', () => ({
  listMcpTokensApi: (...a: unknown[]) => listMcpTokensApi(...a),
  mintMcpTokenApi: vi.fn(),
}));

const STATUS = {
  ok: true,
  targets: {
    claudeCode: { installed: false, urlMatches: false, tokenPrefix: null },
    claudeDesktop: { installed: false, urlMatches: false, tokenPrefix: null },
  },
};

function installShell() {
  (window as unknown as { flutter_inappwebview?: unknown }).flutter_inappwebview = {
    callHandler: (name: string) => {
      if (name === 'mcpStatus') return STATUS;
      return { ok: true };
    },
  };
}

function Probe() {
  const { phase, clients, error } = useDesktopMcpStatus();
  return (
    <div data-testid="probe">
      {phase}:{clients.length}:{error ?? 'no-error'}
    </div>
  );
}

/** A tokens fetch that never resolves on its own but honours the abort signal. */
function hangingFetch(): void {
  listMcpTokensApi.mockImplementation(
    (_token: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  installShell();
  vi.useFakeTimers();
});
afterEach(() => {
  delete (window as unknown as { flutter_inappwebview?: unknown }).flutter_inappwebview;
  vi.useRealTimers();
});

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('useDesktopMcpStatus — bounded tokens fetch', () => {
  it('a starved fetch is aborted per attempt and ends in phase error, never eternal loading', async () => {
    hangingFetch();
    render(<Probe />);
    await advance(0);
    expect(screen.getByTestId('probe').textContent).toMatch(/^loading:/);

    // Sit through every attempt's timeout window (plus slack).
    await advance(TOKENS_FETCH_TIMEOUT_MS * TOKENS_FETCH_ATTEMPTS + 1_000);

    const text = screen.getByTestId('probe').textContent!;
    expect(text).toMatch(/^error:0:/);
    expect(text).not.toMatch(/no-error/);
    // Every attempt got its own call, each carrying an abort signal.
    expect(listMcpTokensApi).toHaveBeenCalledTimes(TOKENS_FETCH_ATTEMPTS);
    for (const call of listMcpTokensApi.mock.calls) {
      expect((call[1] as { signal?: AbortSignal } | undefined)?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('a hang on the first attempt recovers on retry and reaches ready with clients', async () => {
    let attempt = 0;
    listMcpTokensApi.mockImplementation(
      (_token: unknown, init?: { signal?: AbortSignal }) => {
        attempt += 1;
        if (attempt === 1) {
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            );
          });
        }
        return Promise.resolve([]);
      },
    );
    render(<Probe />);
    await advance(TOKENS_FETCH_TIMEOUT_MS + 1_000);

    expect(screen.getByTestId('probe').textContent).toMatch(/^ready:2:no-error/);
    expect(listMcpTokensApi).toHaveBeenCalledTimes(2);
  });

  it('an HTTP failure is NOT retried — it surfaces as error immediately', async () => {
    listMcpTokensApi.mockRejectedValue(new Error('List MCP tokens failed: 401'));
    render(<Probe />);
    await advance(1_000);

    expect(screen.getByTestId('probe').textContent).toMatch(/^error:/);
    expect(listMcpTokensApi).toHaveBeenCalledTimes(1);
  });
});
