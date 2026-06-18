/// <reference types="vite/client" />

// Minimal Stripe.js type declarations for window.Stripe (loaded via CDN script tag).
// No @stripe/stripe-js npm package per std-13 (zero-dep bias).
interface StripeCardElement {
  mount(selector: string): void;
  unmount(): void;
  destroy(): void;
  on(event: 'change', handler: (e: { error?: { message: string } }) => void): void;
}

interface StripeElements {
  create(type: 'card', options?: object): StripeCardElement;
}

interface StripePaymentMethod {
  id: string;
}

interface StripeCreatePaymentMethodResult {
  paymentMethod?: StripePaymentMethod;
  error?: { message: string; type: string };
}

interface StripeInstance {
  elements(options?: object): StripeElements;
  createPaymentMethod(opts: {
    type: 'card';
    card: StripeCardElement;
    billing_details?: { name?: string };
  }): Promise<StripeCreatePaymentMethodResult>;
}

interface Window {
  Stripe?: (publishableKey: string) => StripeInstance;
}
