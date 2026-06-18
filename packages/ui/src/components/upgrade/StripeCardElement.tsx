import { useEffect, useRef, useState } from 'react';

interface Props {
  onReady: (cardElement: StripeCardElement, stripe: StripeInstance) => void;
  onError: (message: string) => void;
}

const STRIPE_PUBLISHABLE_KEY = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as string;

// Loads Stripe.js from CDN if not already present (no npm package per std-13).
function loadStripeScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector('script[src="https://js.stripe.com/v3/"]')) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://js.stripe.com/v3/';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Stripe.js'));
    document.head.appendChild(script);
  });
}

export function StripeCardElement({ onReady, onError }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<StripeCardElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [fieldError, setFieldError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        await loadStripeScript();
        if (cancelled || !window.Stripe || !mountRef.current) return;

        const stripe = window.Stripe(STRIPE_PUBLISHABLE_KEY);
        const elements = stripe.elements();
        const card = elements.create('card', {
          style: {
            base: {
              fontSize: '14px',
              color: '#f8fafc',
              '::placeholder': { color: '#94a3b8' },
            },
          },
        });

        card.mount(mountRef.current);
        card.on('change', (e) => setFieldError(e.error?.message ?? null));
        cardRef.current = card;
        setLoading(false);
        onReady(card, stripe);
      } catch (err) {
        if (!cancelled) onError('Could not load payment form. Please refresh and try again.');
      }
    }

    init();
    return () => {
      cancelled = true;
      cardRef.current?.destroy();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <div
        ref={mountRef}
        className={`rounded-lg border px-3 py-3 bg-input transition-colors ${
          fieldError ? 'border-status-danger-border' : 'border-edge focus-within:border-accent'
        } ${loading ? 'opacity-0 h-10' : ''}`}
      />
      {loading && (
        <div className="h-10 rounded-lg border border-edge bg-input animate-pulse" />
      )}
      {fieldError && (
        <p className="mt-1.5 text-xs text-status-danger-text">{fieldError}</p>
      )}
    </div>
  );
}
