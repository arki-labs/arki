Back to the [README](../../README.md#documentation).

# @arki/math/parse

`Intl` can format in any locale but cannot parse. `parseNumber` and
`parseDecimal` derive the locale's digits, group, decimal and minus symbols
from `Intl.NumberFormat.formatToParts` and read input the way that locale
writes it.

```ts
import { parseDecimal, parseNumber } from '@arki/math/parse';

parseNumber('1,234.56'); // 1234.56
parseNumber('1.234,56', { locale: 'de-DE' }); // 1234.56
parseNumber('1 234,56', { locale: 'fr-FR' }); // 1234.56
parseNumber('−5', { locale: 'sv-SE' }); // -5   (U+2212 minus)
parseDecimal('1,234.56').toString(); // '1234.56'
parseNumber('1.234,56', { symbols: { decimal: ',', group: '.' } }); // 1234.56, no Intl needed
parseNumber('abc'); // throws NumberFormatError
```

The locale decides what a dot means: `'1.234'` is 1.234 in `en-US` and 1234
in `de-DE`.
