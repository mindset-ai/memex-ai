/// <reference types="vite/client" />

// Stripe.js global type declarations were removed with the embedded Card
// Element (spec-171 dec-38 / ac-33). Payment is now collected on Stripe's
// hosted Checkout page, so the app never loads Stripe.js or touches card data.
