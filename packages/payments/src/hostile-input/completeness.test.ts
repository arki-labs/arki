/**
 * The gate covers every public operation
 *
 * The operation list is derived from the package's exports at test time (see
 * `inventory.ts`), so a new export or method without a case fails here.
 */
import { expect, test } from 'vitest';

import { areas } from './areas.js';
import { inventory } from './inventory.js';

/** Classes that are not operations. A failure definition (`defineFailure`) is exempt by its shape. */
const STRUCTURAL_CLASSES = [
  ['core/providers/base-provider.ts::BasePaymentProvider', 'abstract class'],
  ['core/providers/provider-error.ts::PaymentProviderError', 'error class'],
  ['refunds/types.ts::RefundError', 'error class'],
];

const covered = new Map<string, string>();
const duplicates: string[] = [];
for (const definition of areas) {
  const keys = [...definition.cases.map(entry => entry.op), ...Object.keys(definition.exempt ?? {})];
  for (const key of keys) {
    const owner = covered.get(key);
    if (owner !== undefined && owner !== definition.area) duplicates.push(`${key} (${owner}, ${definition.area})`);
    covered.set(key, definition.area);
  }
}

test('every exported function and public method has a case or a listed exemption', async () => {
  const { operations } = await inventory();
  expect(operations.filter(key => !covered.has(key))).toEqual([]);
});

test('every case names an operation that exists', async () => {
  const { operations } = await inventory();
  const known = new Set(operations);
  // `<factory>().<fn>` cases name the operations a factory returns; their factory must exist.
  const stale = [...covered.keys()].filter(key => !known.has(key.split('().')[0] ?? key));
  expect(stale).toEqual([]);
});

test('no operation is covered by two areas', () => {
  expect(duplicates).toEqual([]);
});

test('structural exemptions: failure definitions, plus these classes', async () => {
  const { structural } = await inventory();
  // Every callable the gate leaves out besides `defineFailure` values, with the reason.
  expect([...structural].filter(([, reason]) => reason !== 'failure definition')).toEqual(STRUCTURAL_CLASSES);
});
