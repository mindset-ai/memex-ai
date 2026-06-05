// Consolidates the boilerplate for the three "consume URL token → API call → session"
// pages: VerifyEmail.tsx, MagicLinkConsume.tsx, ResetPassword.tsx (the GET-then-confirm path).
//
// Each page extracts a token from the URL search params, calls a server endpoint with it,
// stages the result through (verifying → success → redirect), and surfaces errors.
// The hook owns the flow state machine; the page only supplies the API call + nav target.

import { useEffect, useState } from 'react';

export type ConsumeStage = 'idle' | 'verifying' | 'success' | 'error';

export interface UseConsumeTokenOptions<T> {
  /** Search-param key. Defaults to 'token'. */
  paramKey?: string;
  /** Called with the extracted raw token; should resolve with the API result. */
  consume: (token: string) => Promise<T>;
  /** Called once on success — typically to set the session and redirect. */
  onSuccess?: (result: T) => void | Promise<void>;
  /** Run automatically on mount (set to false to require an explicit `start()` call). */
  auto?: boolean;
}

export interface UseConsumeTokenReturn<T> {
  stage: ConsumeStage;
  error: string | null;
  result: T | null;
  start: () => void;
}

function tokenFromUrl(paramKey: string): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get(paramKey);
}

export function useConsumeToken<T>({
  paramKey = 'token',
  consume,
  onSuccess,
  auto = true,
}: UseConsumeTokenOptions<T>): UseConsumeTokenReturn<T> {
  const [stage, setStage] = useState<ConsumeStage>('idle');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<T | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!auto && tick === 0) return;
    const token = tokenFromUrl(paramKey);
    if (!token) {
      setStage('error');
      setError('Missing token in URL');
      return;
    }
    let cancelled = false;
    setStage('verifying');
    setError(null);
    consume(token)
      .then(async (value) => {
        if (cancelled) return;
        setResult(value);
        setStage('success');
        if (onSuccess) await onSuccess(value);
      })
      .catch((err) => {
        if (cancelled) return;
        setStage('error');
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [auto, tick, paramKey, consume, onSuccess]);

  return {
    stage,
    error,
    result,
    start: () => setTick((n) => n + 1),
  };
}
