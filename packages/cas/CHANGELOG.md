# @arki/cas

## Unreleased

Conditions, the sign oracle and `simplify` (RFC `2026-10-15-arki-cas` §18 build step 2).

- `@arki/cas/simplify`: `simplify` with the RFC §7 rule table (`fold`, `expand`, `collect`, `cancel`, `integer-powers`, `fractional-powers`, `sqrt-of-square`, `square-of-sqrt`, `exp-ln`, `ln-exp`, `exp-product`, `abs-sign`, `parity`, `special-values`, `factor-out`), applied bottom-up to a fixed point, returning `applied` rule ids; the readable normal form (factored denominator, common kernel factor pulled out, names ordered by name).
- `assume` option and `Assumption`/`Assumptions` types: per-variable signs, per call; a rewrite that relies on one returns it as an `assumed` condition.
- The sign oracle: the set of signs a value can take (so a claim is proven, refuted or unknown; unknown never licenses a rewrite), over assumed names, rigorous ℚ[π, e] constant signs, `exp`, `abs`, roots, even powers and perfect squares, and sign rules.
- Every verb now returns every lost restriction of the input's natural domain, not only cancelled divisors: `ln`/`log` > 0, even roots ≥ 0, fractional powers, `asin`/`acos`, `acosh`, `atanh`, `tan`/`sec`/`cot`/`csc`, `coth`/`csch`. Restrictions the oracle proves from the expression (`x^2 + 1 ≠ 0`) are no longer listed.
- Property tests: exact value preservation in `@arki/expr/rational` at random points (π and e substituted), float checks for kernel rules, conditions necessary at every point where the input is defined, idempotence and round trips; hostile and fuel tests.

### Build step 1

Polynomial core (RFC `2026-10-15-arki-cas` §18 build step 1).

- `@arki/cas/polynomial`: `polynomialIn` (ascending coefficients in ℚ(π, e), `rational` with numerator and denominator, or `other` with a reason and span), `exactRoots` (closed forms for degree 1 and 2 over ℚ and ℚ(π, e), `x^k` and square-free splitting above that, the rest `numeric`), `expand`, `collect`, `rationalize`, `gcd`.
- Sparse multivariate polynomials over ℚ with π, e, names and kernels as generators; a rational-function normal form cancelled by a primitive-PRS gcd; lost divisors returned as `nonzero` conditions.
- ℚ[π, e] zero test (π and e as independent transcendentals, documented as an assumption) and rigorous signs by rational interval arithmetic around `PI`/`E`.
- Output as canonical expr ASTs (printed, then parsed): descending degree, coefficient first, minus signs as subtraction, `numbers: 'fraction' | 'decimal'`.
- `@arki/cas`: `CasError`, `CasLimitError`, `DEFAULT_LIMITS`, `conditionToLatex`, shared types.
- Property tests (ring laws over ℚ[π, e], exact value preservation with π and e substituted, round trips, quadratic roots by substitution in ℚ(√r, i)), hostile-input tests, `size-limit` entries with the measured sizes.
