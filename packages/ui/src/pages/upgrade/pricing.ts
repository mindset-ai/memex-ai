// spec-171 ac-35: hosted-plan pricing math, extracted from UpgradeSeats so it can
// be unit-tested in isolation. Pure module — no React, no side effects.
//
// Annual billing is 17% off 12×the monthly price, i.e. the customer pays for
// ~10 months of a 12-month term. ANNUAL_FACTOR is the per-month multiplier
// applied to the monthly rate when billed annually (1 - 0.17 = 0.83). At the
// default seat counts this yields Premium $249/yr (25×12×0.83) and Enterprise
// $498/yr (50×12×0.83). The annual Stripe price IDs are provisioned to those
// exact totals (config, verified out-of-band), so the UI amount matches the
// charge.

export type UpgradePlan = 'premium' | 'enterprise';

export const PLAN_CONFIG: Record<UpgradePlan, { name: string; monthlyPrice: number }> = {
  premium: { name: 'Premium', monthlyPrice: 25 },
  enterprise: { name: 'Hosted Enterprise', monthlyPrice: 50 },
};

export const ANNUAL_FACTOR = 0.83;

/**
 * Monthly-equivalent price for a seat count. When `annual` is true the per-month
 * rate is discounted by ANNUAL_FACTOR; the annual total is this value × 12.
 */
export function calcPrice(seats: number, monthly: number, annual: boolean): number {
  return seats * monthly * (annual ? ANNUAL_FACTOR : 1);
}
