---
'@arki/math': minor
---

Parsers return, builders throw. `parseNumber`, `parseDecimal` and `fromBase` return the value or an `@arki/failure` value instead of throwing on outside text: `InvalidNumber` (`math.invalid_number`, 400) and `NumberOutOfRange` (`math.number_out_of_range`, 400), listed in `MATH_PARSE_FAILURES` with the derived `MathParseFailure` union. New `parseComplex` does the same for complex text; `decimal`, `ratio` and `complex` stay throwing builders, and arithmetic keeps its documented throws. Bigint `lcm` is capped at 18 000 digits. `@arki/failure` is now the one runtime dependency. See `docs/upgrades/0.1.0-to-0.2.0.md`.
