// Test-only construction of `Mutated<T>` values.
//
// Production code MUST NOT import from this path — `as Mutated<T>` casts are
// forbidden outside `mutate()` and this helper, per the Reactivity Standard.
// Centralizing the cast here keeps the type brand grep-able: the only two
// files that produce `Mutated<T>` are `services/mutate.ts` and this one.
//
// Test fakes that need to satisfy a service signature returning
// `Promise<Mutated<T>>` should wrap their stub return values with
// `testMutate(value)` rather than ad-hoc casts in each test file.

import type { Mutated } from "../mutate.js";

export function testMutate<T>(value: T): Mutated<T> {
  return value as Mutated<T>;
}
