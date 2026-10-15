# @arki/cas

## Unreleased

Polynomial core (RFC `2026-10-15-arki-cas` §18 build step 1).

- `@arki/cas/polynomial`: `polynomialIn` (ascending coefficients in ℚ(π, e), `rational` with numerator and denominator, or `other` with a reason and span), `exactRoots` (closed forms for degree 1 and 2 over ℚ and ℚ(π, e), `x^k` and square-free splitting above that, the rest `numeric`), `expand`, `collect`, `rationalize`, `gcd`.
- Sparse multivariate polynomials over ℚ with π, e, names and kernels as generators; a rational-function normal form cancelled by a primitive-PRS gcd; lost divisors returned as `nonzero` conditions.
- ℚ[π, e] zero test (π and e as independent transcendentals, documented as an assumption) and rigorous signs by rational interval arithmetic around `PI`/`E`.
- Output as canonical expr ASTs (printed, then parsed): descending degree, coefficient first, minus signs as subtraction, `numbers: 'fraction' | 'decimal'`.
- `@arki/cas`: `CasError`, `CasLimitError`, `DEFAULT_LIMITS`, `conditionToLatex`, shared types.
- Property tests (ring laws over ℚ[π, e], exact value preservation with π and e substituted, round trips, quadratic roots by substitution in ℚ(√r, i)), hostile-input tests, `size-limit` entries with the measured sizes.
