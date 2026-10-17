// #region invoice
import { decimal } from '@arki/math/decimal';

type InvoiceLine = { readonly price: string; readonly quantity: number };

/** Totals an invoice exactly. Only the tax step rounds, and it says how. */
export function invoiceTotals(lines: readonly InvoiceLine[], taxRate: string) {
  const subtotal = lines.reduce((total, line) => total.plus(decimal(line.price).times(line.quantity)), decimal(0));
  const tax = subtotal.times(taxRate).toScale(2, 'halfEven');
  return { subtotal: subtotal.toString(), tax: tax.toString(), total: subtotal.plus(tax).toString() };
}

invoiceTotals(
  [
    { price: '19.99', quantity: 3 },
    { price: '0.10', quantity: 3 },
  ],
  '0.19',
);
// { subtotal: '60.27', tax: '11.45', total: '71.72' }
// #endregion invoice
