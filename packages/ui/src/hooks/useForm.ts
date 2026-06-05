// Lightweight form-state hook for the auth-flow pages (Signup, Login, ResetPassword,
// VerifyEmail, MagicLinkConsume, InviteAccept). Replaces the duplicated
// useState({email}) + useState(submitting) + try/catch/setError pattern.
//
// Deliberately minimal — no validation framework, no field arrays. If a form needs more
// than this, it should reach for react-hook-form or zod-form-data; until then this hook
// covers the ~10 places we copy-paste the same five lines.

import { useCallback, useState } from 'react';

export interface UseFormReturn<T> {
  values: T;
  setField: <K extends keyof T>(key: K, value: T[K]) => void;
  setValues: (next: Partial<T>) => void;
  submit: (e?: { preventDefault?: () => void }) => Promise<void>;
  submitting: boolean;
  error: string | null;
  reset: () => void;
}

export interface UseFormOptions<T> {
  initial: T;
  onSubmit: (values: T) => Promise<void> | void;
  /** Called with the caught error. Default: stringify and surface via `error`. */
  onError?: (err: unknown) => string;
}

function defaultErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function useForm<T extends Record<string, unknown>>({
  initial,
  onSubmit,
  onError = defaultErrorMessage,
}: UseFormOptions<T>): UseFormReturn<T> {
  const [values, setValuesState] = useState<T>(initial);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setField = useCallback<UseFormReturn<T>['setField']>((key, value) => {
    setValuesState((prev) => ({ ...prev, [key]: value }));
  }, []);

  const setValues = useCallback<UseFormReturn<T>['setValues']>((next) => {
    setValuesState((prev) => ({ ...prev, ...next }));
  }, []);

  const submit = useCallback<UseFormReturn<T>['submit']>(
    async (e) => {
      e?.preventDefault?.();
      setSubmitting(true);
      setError(null);
      try {
        await onSubmit(values);
      } catch (err) {
        setError(onError(err));
      } finally {
        setSubmitting(false);
      }
    },
    [values, onSubmit, onError],
  );

  const reset = useCallback(() => {
    setValuesState(initial);
    setError(null);
    setSubmitting(false);
  }, [initial]);

  return { values, setField, setValues, submit, submitting, error, reset };
}
