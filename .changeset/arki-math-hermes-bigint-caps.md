---
'@arki/math': minor
---

Lower bigint caps, the same on every runtime, from measured Hermes V1 limits (it rejects bigints past about 19,690 digits). No bigint the library builds passes 18,000 digits: bigint `factorial` stops at n = 5,450 (was 25,205), `combinations`, `permutations` and `lcm` at 18,000 result digits (was 100,000), and roots take a radicand of at most 18,000 digits (was 200,000). Decimal and Rational still keep 10,000 digits per value, but any operation whose bigint intermediate would pass 18,000 digits (multiply, divide, align scales, compare, `exp`, `ln`, `log`, `pow`, roots, `modPow`, `isPythagoreanTriple`) throws `ResourceLimitError` before building it. Two 10,000-digit operands cannot be multiplied. See `docs/upgrades/0.1.0-to-0.2.0.md`.
