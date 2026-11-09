---
"@arki/string": minor
---

`levenshtein` and `jaroWinkler` take an optional `{ maxCells }`. Their time grows with the grapheme count of `a` times that of `b`; when that product is over `maxCells` they return the new failure `ComparisonTooLarge` (`string.comparison_too_large`, status 413) and compute nothing. With the option the result type is `number | ComparisonTooLarge`; without it, it stays `number` and nothing changes. A negative or `NaN` `maxCells` throws `StringError` `ARKI_STRING_E001`. New export: type `CellLimit`.
