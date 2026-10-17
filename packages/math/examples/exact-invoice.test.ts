import { describe, expect, it } from 'vitest';

import { invoiceTotals } from './exact-invoice.js';

describe('examples/exact-invoice.ts', () => {
  // The README quick start shows this file, so its numbers must stay true.
  it('keeps every cent: float math drifts, this does not', () => {
    const lines = [
      { price: '19.99', quantity: 3 },
      { price: '0.10', quantity: 3 },
    ];
    expect(invoiceTotals(lines, '0.19')).toEqual({ subtotal: '60.27', tax: '11.45', total: '71.72' });
    expect(19.99 * 3 + 0.1 * 3).not.toBe(60.27);
  });

  it('rounds the tax half-even, to the cent', () => {
    expect(invoiceTotals([{ price: '1.00', quantity: 1 }], '0.125').tax).toBe('0.12');
    expect(invoiceTotals([{ price: '3.00', quantity: 1 }], '0.125').tax).toBe('0.38');
  });
});
