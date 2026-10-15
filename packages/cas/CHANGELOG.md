# @arki/cas

## Unreleased

`derivative` and the rule-by-rule `derivation` (RFC `2026-10-15-arki-cas` §18 build step 3).

- `@arki/cas/derivative`: `derivative(input, variable, { order, simplify })`, any order up to the `order` budget, other names constant, normalized between orders by the rule table; conditions for the input's lost restrictions (`ln(x)` → `1/x` needs `x > 0`) and `u ≠ 0` for `abs(u)` (reason `differentiable`). Jump functions throw `not-differentiable`, `factorial`/`gamma`/host functions `unsupported-function`, both with the call's span (no span after the first order).
- `@arki/cas/derivation`: `derivation`, `ruleFormula`, `TEMPLATE_KEYS` and the `DerivationStep` tree: one step per rule application, the chain rule as its own step, `repeat` steps for subterms derived before, and per order a simplification shown as the normal form plus one step per rule. `derivative`'s bundle contains no step code (`scripts/entries.mjs` checks the built package).
- Hash-consed differentiation: each distinct subterm is derived once, so cost and step count are linear in the DAG.
- New budgets `order` (10), `steps` (2 000) and `stepNodes` (50 000).
- `simplify` rules can be switched on one at a time (internal), which a derivation uses to show each rule as a step; `simplify` itself is unchanged.
- Tests: the Ekuation corpus results, conditions, errors and budgets; properties against `@arki/math/differentiate` at random points, exact polynomial coefficients, order n as order 1 applied n times, and every derivation step checked numerically on its own; cross-runtime smoke with a 5th-order derivation.

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
