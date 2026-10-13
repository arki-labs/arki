---
'@arki/math': patch
---

Faster statistics, distributions and decimal parsing, with the same results and checks.

- `mean` and `sum` check and add the numbers in one pass, with two compensated running totals instead of one, so they keep their accuracy and run several times faster.
- `variance` and `stddev` use the corrected two-pass algorithm (mean, then squared deviations less a rounding correction) instead of Welford's update, which needed a division per value. It is at least as accurate and about three times faster.
- `percentile` and `quantile` copy the values into a typed array and pick the two ranks they need with quickselect instead of sorting the whole copy: about 20 times faster on 1,000 values.
- `erf`, `erfc` and every normal-distribution `cdf`, `sf` and `quantile` use W. J. Cody's rational approximations instead of the incomplete gamma function. They are about 5 times faster and slightly more accurate in the far tail.
- `decimal('…')` reads the text in a single scan and builds short coefficients (up to 15 digits) from a number, instead of a regular expression plus `BigInt` on the digit text.
