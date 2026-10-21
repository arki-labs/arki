Back to the [README](../../README.md#documentation).

# @arki/math/words

Numbers as words and ordinals, with real grammar per language. English is
built in; other languages are separate subpaths so you bundle only what you
use. Pass the rule object — there is no global locale.

```ts
import { enGB, formatOrdinal, spellNumber, spellOrdinal } from '@arki/math/words';
import { es } from '@arki/math/words/es';
import { fr } from '@arki/math/words/fr';
import { ro } from '@arki/math/words/ro';

spellNumber(1234); // 'one thousand two hundred thirty-four'
spellNumber(102, { locale: enGB }); // 'one hundred and two'
spellNumber('3.14'); // 'three point one four'
spellNumber(11, { until: 10 }); // '11'   Laravel-style thresholds
spellOrdinal(21); // 'twenty-first'
formatOrdinal(1001); // '1,001st'

spellNumber(21000, { locale: ro }); // 'douăzeci și una de mii'
spellNumber(2, { locale: ro, gender: 'feminine' }); // 'două'
spellOrdinal(2, { locale: ro, gender: 'feminine' }); // 'a doua'
formatOrdinal(21, { locale: ro }); // 'al 21-lea'
spellNumber(81, { locale: fr }); // 'quatre-vingt-un'
spellNumber(21000, { locale: es }); // 'veintiún mil'
```

Available: `en` (American), `enGB` (British "and"), `ro`, `de`, `fr`, `es`,
`it`. Each locale object implements `NumberWordsLocale`; adding a language is
one file against that contract. Locales are objects you import rather than
`Intl`-style strings so that a bundle only carries the languages it uses.

Thresholds: a number is spelled when `after < |value| ≤ until`; outside
that window it comes back as locale-formatted digits with its value intact
(`spellNumber('0.0001', { after: 1 })` → `'0.0001'`). Each locale has a
magnitude limit (`maxGroups`, in base-1000 groups) beyond which it throws
`NumericRangeError` before doing any work.
