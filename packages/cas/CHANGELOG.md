# @arki/cas

## Unreleased

Release preparation (RFC `2026-10-15-arki-cas` §18 build step 5). The package is now public (Wave 5, Specialized), together with `@arki/expr`.

- README: a guarantee table (what each verb promises and the tests that back it) and the English text of all 58 step template keys.
- Benchmarks: `bench/cas.bench.ts` against mathjs (pruned), Algebrite and nerdamer, with a contract check before timing: the same values at 5 points for derivatives and simplified forms, the same coefficients for expansions, the same factors up to units for factorizations. Libraries that fail an input, or that did not finish in an untimed probe, are left out or shown unranked, with the reason in the notes. A `derivative` build with the step recorder deleted measures the zero-cost claim (RFC §9.2). README numbers come later, from an idle-machine publish run.
- Tests: a `gcd` property (gcd(A·C, B·C) is divisible by C, divides both inputs and leaves coprime cofactors).

Fixes found by a review before publishing:

- Conditions: `Relation` gains `negative`, so an assumed `x < 0` comes back as `x < 0 (assumed)`, not `-x > 0`; `conditionToLatex` prints `< 0`. One merge step serves every verb: `u ≥ 0` and `u ≠ 0` become `u > 0`, and a condition another one implies is dropped (`abs(x) + ln(x)` gives only `x > 0`). `asec`, `acsc`, `acsch`, `asech` and `acoth` have domain rows, from expr's `1/u` definitions.
- `u^(k/2)` is read as `sqrt(u)^k`: `x^(1/2) - sqrt(x)` is `0`, `x^(3/2)/x` is `sqrt(x)` for `x > 0`, `(x^2)^(1/2)` is `abs(x)`, `sqrt(exp(x))` is `exp(x/2)`. New `square-of-sqrt` case `u/sqrt(u) → sqrt(u)`.
- `applied` reports `fold` for literal arithmetic it missed (`3*x*2`, `x^2^3`, `1/x^-1`) and no longer for a division that changes nothing (`x/2`, `3/2`).
- `factor` and `gcd` throw `CasError` `not-polynomial` with the span of the offending part, instead of a plain `InvalidArgumentError`.
- `factor` marks a result complete when every part left whole has degree 1 in the variable (`x^2 + 2xy + y^2` is `(x + y)^2`, complete).
- The sign oracle knows `log10` and `log2`; `parity` knows `acot`, `acsc`, `acsch` and `acoth` are odd.
- A lost restriction the caller's assumptions guarantee is no longer listed (`sqrt(x)*sqrt(x)` with `x` positive has no conditions).
- `factor` and `gcd` throw `CasError` `unsupported-constant` for constants with no zero test (`sqrt(2)`, `ln(2)`): as free symbols they hid zeros (`sqrt(2)^2 - 2`) and gave wrong gcds (`gcd(x - sqrt(2), x^2 - 2)` was 1).
- `gcd` with several generators returns coprime integer coefficients with the term that prints first positive, as documented (`gcd(x^2 - pi^2, x - pi)` was `-x + pi`); a part `factor` leaves whole gets the same sign rule. Both no longer depend on internal generator ids.
- Tests: time bounds use CPU time, the fastest of up to 3 runs (`src/test-support.ts`), so a loaded machine cannot fail them; the test timeout is 30 s.

### Build step 4

`factor` over ℚ (RFC `2026-10-15-arki-cas` §18 build step 4).

- `@arki/cas/polynomial`: `factor(input, variable)` returns `content`, `factors` (with multiplicities), `complete` and `conditions`. Rational univariate polynomials factor completely by Zassenhaus: Yun square-free split, best of 5 primes, distinct-degree and Cantor–Zassenhaus splitting with a fixed seed, quadratic Hensel lifting over a factor tree, subset recombination. Names, π and e may sit in the content; a part that involves them stays whole with `complete: false`.
- `exactRoots` splits rational polynomials of degree ≥ 3 by `factor`: linear and quadratic factors give exact roots (`x^4 - 5x^2 + 4` → −2, −1, 1, 2); factors of degree ≥ 3 stay `numeric`. A factoring budget falls back to the square-free split.
- A heuristic gcd (GCDHEU) for the square-free split, with the PRS gcd as fallback, and a fast path: if `f mod p` is square-free, so is `f`.
- New budgets `factorDegree` (128), `factorDigits` (300), `liftDigits` (2 000) and `recombination` (65 536). Bigint arithmetic in factoring spends fuel by operand size.
- Tests: 45 SymPy reference fixtures (`test/reference/gen_factor.py`), properties (the product rebuilds the input; factors of A·B are those of A and B), budgets and a hostile degree-128 input that must end within a second; cross-runtime smoke with `x^60 - 1` and a degree-40 product.

### Build step 3

`derivative` and the rule-by-rule `derivation` (RFC `2026-10-15-arki-cas` §18 build step 3).

- `@arki/cas/derivative`: `derivative(input, variable, { order, simplify })`, any order up to the `order` budget, other names constant, normalized between orders by the rule table; conditions for the input's lost restrictions (`ln(x)` → `1/x` needs `x > 0`) and `u ≠ 0` for `abs(u)` (reason `differentiable`). Jump functions throw `not-differentiable`, `factorial`/`gamma`/host functions `unsupported-function`, both with the call's span (no span after the first order).
- `@arki/cas/derivation`: `derivation`, `ruleFormula`, `TEMPLATE_KEYS` and the `DerivationStep` tree: one step per rule application, the chain rule as its own step, `repeat` steps for subterms derived before, and per order a simplification shown as the normal form plus one step per rule. `derivative`'s bundle contains no step code (`scripts/entries.mjs` checks the built package).
- Hash-consed differentiation: each distinct subterm is derived once, so cost and step count are linear in the DAG.
- New budgets `order` (10), `steps` (2 000) and `stepNodes` (50 000).
- `simplify` rules can be switched on one at a time (internal), which a derivation uses to show each rule as a step; `simplify` itself is unchanged.
- Tests: the derivative calculator corpus results, conditions, errors and budgets; properties against `@arki/math/differentiate` at random points, exact polynomial coefficients, order n as order 1 applied n times, and every derivation step checked numerically on its own; cross-runtime smoke with a 5th-order derivation.

### Build step 2

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
