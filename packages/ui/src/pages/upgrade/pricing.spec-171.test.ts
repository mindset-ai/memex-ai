// spec-171 ac-35: annual = 17% off 12×monthly. At the default plan rates this is
// Premium $249/yr (25×12×0.83) and Enterprise $498/yr (50×12×0.83); monthly is
// the raw rate. calcPrice returns the monthly-equivalent, so the annual total is
// calcPrice(...) × 12.
//
// The "amount shown matches what Stripe charges" half is config: the annual
// Stripe price IDs are provisioned to exactly $249 / $498 (verified out-of-band,
// not by this unit test). This test pins the UI-side math only.

import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { calcPrice, PLAN_CONFIG, ANNUAL_FACTOR } from './pricing';

const AC_35 = 'mindset-prod/memex-building-itself/specs/spec-171/acs/ac-35';

describe('spec-171 ac-35: hosted plan pricing (annual = 17% off 12×monthly)', () => {
  it('annual factor is the 17%-off multiplier', () => {
    tagAc(AC_35);
    expect(ANNUAL_FACTOR).toBeCloseTo(0.83, 5);
  });

  it('Premium annual = $249/yr (25 × 12 × 0.83), monthly unchanged', () => {
    tagAc(AC_35);
    const monthly = PLAN_CONFIG.premium.monthlyPrice;
    expect(monthly).toBe(25);

    // Annual total for one seat = 12 × the discounted monthly-equivalent.
    const annualTotal = calcPrice(1, monthly, true) * 12;
    expect(annualTotal).toBeCloseTo(249, 2);

    // Monthly is the raw rate (no discount).
    expect(calcPrice(1, monthly, false)).toBe(25);
  });

  it('Enterprise annual = $498/yr (50 × 12 × 0.83), monthly unchanged', () => {
    tagAc(AC_35);
    const monthly = PLAN_CONFIG.enterprise.monthlyPrice;
    expect(monthly).toBe(50);

    const annualTotal = calcPrice(1, monthly, true) * 12;
    expect(annualTotal).toBeCloseTo(498, 2);

    expect(calcPrice(1, monthly, false)).toBe(50);
  });

  it('scales linearly with seat count', () => {
    tagAc(AC_35);
    // 5 Premium seats, annual = 5 × $249.
    expect(calcPrice(5, PLAN_CONFIG.premium.monthlyPrice, true) * 12).toBeCloseTo(
      5 * 249,
      2,
    );
  });
});
