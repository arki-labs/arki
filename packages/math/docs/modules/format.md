Back to the [README](../../README.md#documentation).

# @arki/math/format

Built on `Intl.NumberFormat`, so every locale the runtime knows is
supported with no tables shipped. `Decimal` values are passed to `Intl` as
exact strings (ES2023 "NumberFormat v3") — a 30‑digit amount formats with
all 30 digits. Formatter instances are cached, which is where the speed is.

```ts
import { decimal } from '@arki/math/decimal';
import {
  createFormatter,
  formatCompact,
  formatCurrency,
  formatFileSize,
  formatNumber,
  formatPercent,
} from '@arki/math/format';

formatNumber(1234567.891); // '1,234,567.891'
formatNumber(2.5, { maximumFractionDigits: 0, rounding: 'halfEven' }); // '2'
formatCurrency(1234.5, 'EUR', { locale: 'de-DE' }); // '1.234,50 €'
formatCurrency(-5, 'USD', { accounting: true }); // '($5.00)'
formatCurrency(decimal('0.1').plus('0.2'), 'USD'); // '$0.30' — exact in, exact out
formatPercent(0.125); // '12.5%'  — input is a fraction, as in Intl
formatCompact(1230000); // '1.2M'
formatCompact(1230000, { display: 'long' }); // '1.2 million'
formatCompact(1_250_000, { currency: 'USD' }); // '$1.3M'
formatFileSize(1536); // '1.5 kB'
formatFileSize(1536, { system: 'iec' }); // '1.5 KiB'
formatFileSize(1536, { system: 'jedec' }); // '1.5 KB'  — powers of 1024, KB/MB/GB labels

const ro = createFormatter({ locale: 'ro-RO', currency: 'RON' });
ro.formatCurrency(25); // '25,00 RON'
ro.formatPercent(0.07); // '7 %'
```

There is no global "current locale": the default is `en-US`, every call
takes `{ locale }`, and `createFormatter` binds defaults for an app or a
request without mutating shared state. That keeps SSR, tests, and
concurrent requests honest. To format like `toLocaleString()` does, in the
runtime's own locale, ask for it by name: `{ locale: 'default' }` (exported as
`RUNTIME_LOCALE`). A missing locale never means the runtime's.

Ordinals and number‑to‑words are not included — `Intl` has no style for
them, and English suffix tables would be wrong everywhere else.
